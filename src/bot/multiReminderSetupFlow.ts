import { DateTime } from "luxon";

import { recordAgentAction, updateAgentAction } from "@/db/queries/agentActions";
import type { PlannerItem } from "@/db/schema";
import {
  detectBeforeEventReminderMode,
  parseBeforeEventReminderSpecsForAnchor,
} from "@/domain/beforeEventReminderParsing";
import { applyItemEditMutation, type ItemEditMutation } from "@/services/itemEditMutations";
import {
  clearActiveMultiReminderSetupSession,
  getActiveMultiReminderSetupSession,
} from "@/services/multiReminderSetupSessions";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { itemMenuKeyboard } from "./keyboards";
import { replyAndRecord } from "./reply";

export async function handleMultiReminderSetupTurn(
  ctx: BotContext,
  text: string,
  timezone: string,
): Promise<boolean> {
  const owner = requireOwner(ctx);
  const now = new Date();
  const session = await getActiveMultiReminderSetupSession({ userId: owner.id, now }).catch(
    () => null,
  );
  if (!session) return false;

  const anchor = session.item.startAt ?? session.item.dueAt;
  if (!anchor) {
    await clearActiveMultiReminderSetupSession({
      userId: owner.id,
      reason: "target_item_has_no_anchor",
      now,
    });
    await replyAndRecord(
      ctx,
      `У «${session.item.title}» нет времени события. Сначала поставь время, потом добавлю напоминания.`,
      { reply_markup: itemMenuKeyboard(session.item.id) },
    );
    return true;
  }

  const parsed = parseBeforeEventReminderSpecsForAnchor({
    text,
    anchor,
    timezone: session.item.timezone || timezone,
    now,
    allowAbsoluteTimes: true,
  });

  if (!parsed.reminders.length) {
    await recordAgentAction({
      userId: owner.id,
      sourceMessageId: ctx.dbMessageId,
      actionType: "multi_reminder_setup_parse",
      status: "noop",
      input: {
        activeSessionType: "multi_reminder_setup_session",
        sessionTargetItemId: session.item.id,
        text: text.slice(0, 1200),
      },
      output: {
        pastLabels: parsed.pastLabels,
        routingDecision: "keep_multi_reminder_setup_session_open",
        localMutationSucceeded: false,
        calendarSyncStatus: "not_requested",
      },
    });
    await replyAndRecord(
      ctx,
      parsed.pastLabels.length
        ? [
            `Не поставил: ${parsed.pastLabels.join(", ")} уже прошли для «${session.item.title}».`,
            "Напиши будущее время до события, например: «за 2 часа и за 30 минут».",
          ].join("\n")
        : `Я настраиваю несколько напоминаний для «${session.item.title}». Напиши, например: «в 7:00 и 7:30» или «за день в 9, за 2 часа и за 30 минут».`,
    );
    return true;
  }

  const mode = detectBeforeEventReminderMode(text);
  const mutation: ItemEditMutation = {
    itemId: session.item.id,
    reminderPolicy: {
      policyType: "before_event_multi",
      reminders: parsed.reminders,
      mode: mode === "ask" ? "add" : mode,
      mutationSource: "multi_reminder_setup_session",
    },
    changedFields: ["reminder_policy"],
    warnings: parsed.pastLabels.map((label) => `before_event_in_past:${label}`),
    pastConfirmationRequired: false,
  };
  const result = await applyItemEditMutation({
    userId: owner.id,
    item: session.item,
    mutation,
    timezone,
    sourceMessageId: ctx.dbMessageId,
    now,
  });
  await updateAgentAction({
    userId: owner.id,
    actionId: session.action.id,
    status: "completed",
    output: {
      ...(session.action.output ?? {}),
      activeSessionType: "multi_reminder_setup_session",
      sessionTargetItemId: session.item.id,
      intendedMutation: "before_event_reminder_policy",
      actualMutation: "before_event_reminder_policy",
      routingDecision: "handled_by_multi_reminder_setup_session",
      localMutationSucceeded: Boolean(result.item),
      calendarSyncStatus: "not_requested",
      createdPolicyIds: result.policyIds,
      createdReminderIds: result.reminderIds,
      pastLabels: parsed.pastLabels,
      completedAt: now.toISOString(),
    },
    undoPayload: result.undoPayload,
  });
  await clearActiveMultiReminderSetupSession({
    userId: owner.id,
    reason: "multi_reminder_setup_applied",
    now,
  });

  await replyAndRecord(
    ctx,
    formatMultiReminderApplied(session.item, parsed.reminders, parsed.pastLabels),
    {
      reply_markup: itemMenuKeyboard(session.item.id),
    },
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

function formatMultiReminderApplied(
  item: PlannerItem,
  reminders: Array<{ label: string; fireAtLocal: string }>,
  pastLabels: string[],
) {
  const zone = item.timezone || "Europe/Moscow";
  const lines = ["Готово:", item.title, "", "Напоминания:"];
  for (const reminder of reminders) {
    const fire = DateTime.fromISO(reminder.fireAtLocal, { zone });
    lines.push(`• ${reminder.label}${fire.isValid ? ` (${fire.toFormat("dd.LL HH:mm")})` : ""}`);
  }
  if (pastLabels.length) {
    lines.push("", `Не добавил прошедшие: ${pastLabels.join(", ")}.`);
  }
  return lines.join("\n");
}
