import { recordAgentAction } from "@/db/queries/agentActions";
import { listManageableItems } from "@/db/queries/items";
import type { PlannerItem } from "@/db/schema";
import {
  detectBeforeEventReminderMode,
  parseBeforeEventReminderSpecsForAnchor,
} from "@/domain/beforeEventReminderParsing";
import { applyItemEditMutation, type ItemEditMutation } from "@/services/itemEditMutations";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { entityListKeyboard, itemMenuKeyboard } from "./keyboards";
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
    .filter((item) => isRecentFutureEventCandidate(item, now))
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
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
    await replyAndRecord(
      ctx,
      [
        "К какому событию добавить эти напоминания?",
        ...parseByItem.slice(0, 5).map((entry, index) => `${index + 1}. ${entry.item.title}`),
      ].join("\n"),
      {
        reply_markup: entityListKeyboard(
          parseByItem.slice(0, 5).map((entry) => ({ type: "planner_item", id: entry.item.id })),
        ),
      },
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

function isReminderOnlyFollowup(text: string) {
  const normalized = text.toLocaleLowerCase("ru").replace(/ё/g, "е");
  return (
    /(напомн|напоминан)/i.test(normalized) &&
    /за\s+(?:день|пол\s*часа|полчаса|полтора|час|один|одну|два|две|три|\d+\s*(?:час|мин))/i.test(
      normalized,
    ) &&
    !/(создай|добавь|запиши|встреч|созвон|эфир|тренировк|мероприят|событи)/i.test(normalized)
  );
}

function isRecentFutureEventCandidate(item: PlannerItem, now: Date) {
  if (!["event", "training", "tentative_event"].includes(item.kind)) return false;
  const anchor = item.startAt ?? item.dueAt;
  if (!anchor || anchor <= now) return false;
  return now.getTime() - item.createdAt.getTime() <= 6 * 60 * 60 * 1000;
}
