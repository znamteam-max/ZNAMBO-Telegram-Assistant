import { recordAgentAction } from "@/db/queries/agentActions";
import { listManageableItems } from "@/db/queries/items";
import type { PlannerItem } from "@/db/schema";
import {
  detectBeforeEventReminderMode,
  parseBeforeEventReminderSpecsForAnchor,
} from "@/domain/beforeEventReminderParsing";
import { looksLikeExplicitNewScheduledCreationText } from "@/domain/scheduledCreationIntent";
import { applyItemEditMutation, type ItemEditMutation } from "@/services/itemEditMutations";
import {
  candidateFromItem,
  formatReminderTargetPrompt,
  reminderTargetKeyboard,
  startReminderTargetResolutionSession,
} from "@/services/eventTargetResolution";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { itemMenuKeyboard } from "./keyboards";
import { replyAndRecord } from "./reply";

export async function handleRecentEventReminderTurn(
  ctx: BotContext,
  text: string,
  timezone: string,
): Promise<boolean> {
  if (!isReminderOnlyFollowup(text)) return false;
  const owner = requireOwner(ctx);
  const now = new Date();
  const candidates = (await listManageableItems(owner.id, 80))
    .filter((item) => isFutureEventCandidate(item, now))
    .sort((left, right) => candidateSortScore(right, now) - candidateSortScore(left, now));
  if (!candidates.length) return false;

  const parseByItem = candidates
    .map((item) => {
      const anchor = item.startAt ?? item.dueAt;
      return {
        item,
        parsed: anchor
          ? parseBeforeEventReminderSpecsForAnchor({
              text,
              anchor,
              timezone: item.timezone || timezone,
              now,
              allowAbsoluteTimes: false,
            })
          : null,
      };
    })
    .filter((entry) => entry.parsed?.reminders.length);
  if (!parseByItem.length) return false;

  if (parseByItem.length > 1) {
    const action = await startReminderTargetResolutionSession({
      userId: owner.id,
      sourceMessageId: ctx.dbMessageId,
      originalText: text,
      reminders: parseByItem[0].parsed!.reminders,
      reminderMode: detectBeforeEventReminderMode(text) === "replace" ? "replace" : "add",
      candidates: parseByItem.slice(0, 8).map((entry, index) => candidateFromItem(entry.item, 1 - index / 10)),
      now,
    });
    await replyAndRecord(
      ctx,
      formatReminderTargetPrompt({
        reminders: parseByItem[0].parsed!.reminders,
        candidates: parseByItem.slice(0, 8).map((entry, index) => candidateFromItem(entry.item, 1 - index / 10)),
        timezone,
      }),
      action
        ? { reply_markup: reminderTargetKeyboard(action.id, Math.min(parseByItem.length, 8)) }
        : undefined,
    );
    return true;
  }

  const { item, parsed } = parseByItem[0];
  if (!parsed) return false;
  const mode = detectBeforeEventReminderMode(text);
  const mutation: ItemEditMutation = {
    itemId: item.id,
    reminderPolicy: {
      policyType: "before_event_multi",
      reminders: parsed.reminders,
      mode: mode === "ask" ? "add" : mode,
      mutationSource: "recent_event_reminder_followup",
    },
    changedFields: ["reminder_policy"],
    warnings: parsed.pastLabels.map((label) => `before_event_in_past:${label}`),
    pastConfirmationRequired: false,
  };
  const result = await applyItemEditMutation({
    userId: owner.id,
    item,
    mutation,
    timezone,
    sourceMessageId: ctx.dbMessageId,
    now,
  });
  await recordAgentAction({
    userId: owner.id,
    sourceMessageId: ctx.dbMessageId,
    actionType: "recent_event_reminder_followup_apply",
    status: result.item ? "completed" : "failed",
    input: {
      text: text.slice(0, 1200),
      targetItemId: item.id,
      routingDecision: "recent_event_reminder_followup",
    },
    output: {
      localMutationSucceeded: Boolean(result.item),
      createdPolicyIds: result.policyIds,
      createdReminderIds: result.reminderIds,
      warnings: result.warnings,
      calendarSyncStatus: "not_requested",
    },
    undoPayload: result.undoPayload,
  });
  await replyAndRecord(
    ctx,
    [
      "Готово:",
      item.title,
      "",
      "Напоминания:",
      ...parsed.reminders.map((reminder) => `• ${reminder.label}`),
    ].join("\n"),
    { reply_markup: itemMenuKeyboard(item.id) },
  );
  if (ctx.chat?.id) {
    await refreshDashboardAfterMutation({
      userId: owner.id,
      chatId: ctx.chat.id,
      timezone,
    });
  }
  return true;
}

export function isReminderOnlyFollowup(text: string) {
  if (looksLikeExplicitNewScheduledCreationText(text)) return false;
  const normalized = text.toLocaleLowerCase("ru").replace(/ё/g, "е");
  const hasOffset =
    /за\s+(?:день|пол\s*часа|полчаса|полтора(?:\s+часа)?|час|(?:один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять)\s*(?:час(?:а|ов)?|ч\.?|мин(?:ут(?:у|ы)?)?|м\.?)?|\d+\s*(?:час|ч\.?|мин))/i.test(
      normalized,
    );
  const hasReminderVerb = /(напомн|напоминан)/i.test(normalized);
  const hasEventCreation =
    /(создай|добавь|запиши|встреч|созвон|эфир|тренировк|мероприят|событи|массаж|визит|при[её]м|запись)/i.test(
      normalized,
    );
  return (
    hasOffset &&
    (hasReminderVerb || looksLikeBareOffsetList(normalized)) &&
    !hasEventCreation
  );
}

function isFutureEventCandidate(item: PlannerItem, now: Date) {
  if (!["event", "training", "tentative_event"].includes(item.kind)) return false;
  const anchor = item.startAt ?? item.dueAt;
  if (!anchor || anchor <= now) return false;
  return anchor.getTime() <= now.getTime() + 14 * 24 * 60 * 60 * 1000;
}

function candidateSortScore(item: PlannerItem, now: Date) {
  const recentBoost = now.getTime() - item.createdAt.getTime() <= 6 * 60 * 60 * 1000 ? 1_000_000 : 0;
  const anchor = item.startAt ?? item.dueAt ?? new Date(Number.MAX_SAFE_INTEGER);
  return recentBoost - Math.max(0, anchor.getTime() - now.getTime()) / 60_000;
}

function looksLikeBareOffsetList(normalized: string) {
  const stripped = normalized
    .replace(
      /за\s+(?:день|пол\s*часа|полчаса|полтора(?:\s+часа)?|час|(?:один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять)\s*(?:час(?:а|ов)?|ч\.?|мин(?:ут(?:у|ы)?)?|м\.?)?|\d+\s*(?:час(?:а|ов)?|ч\.?|мин(?:ут(?:у|ы)?)?|м\.?))/gi,
      "",
    )
    .replace(/[,\s.и]+/gi, "");
  return stripped.length === 0;
}
