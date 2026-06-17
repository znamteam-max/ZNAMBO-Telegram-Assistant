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
    ctx.deterministicTrace = {
      preRouterIntent: "multi_reminder_setup_session",
      aiRequired: false,
      aiCalled: false,
      aiSucceeded: false,
      structuredOutputValid: true,
      toolCallsProposed: ["parse_before_event_reminders"],
      toolCallsExecuted: [],
      fallbackUsed: false,
      fallbackReason: null,
      validationWarnings: ["target_item_has_no_anchor"],
      toolExecutionFailed: null,
      toolFailureReason: "target_item_has_no_anchor",
      toolFailureField: "event_time",
      suggestedNextPrompt: "Сначала поставь время события.",
      finalAction: "reminder_setup_target_needs_time",
      errorCode: null,
      safeErrorMessage: null,
    };
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
        reason: "could_not_parse_reminder_offsets",
        field: "reminder_offsets",
        suggestedNextPrompt: "за 2 часа и за 30 минут",
        routingDecision: "keep_multi_reminder_setup_session_open",
        localMutationSucceeded: false,
        calendarSyncStatus: "not_requested",
      },
    });
    ctx.deterministicTrace = {
      preRouterIntent: "multi_reminder_setup_session",
      aiRequired: false,
      aiCalled: false,
      aiSucceeded: false,
      structuredOutputValid: true,
      toolCallsProposed: ["parse_before_event_reminders"],
      toolCallsExecuted: [],
      fallbackUsed: false,
      fallbackReason: null,
      validationWarnings: parsed.pastLabels.length
        ? parsed.pastLabels.map((label) => `before_event_in_past:${label}`)
        : ["could_not_parse_reminder_offsets"],
      toolExecutionFailed: null,
      toolFailureReason: "could_not_parse_reminder_offsets",
      toolFailureField: "reminder_offsets",
      suggestedNextPrompt: "за 2 часа и за 30 минут",
      finalAction: "reminder_setup_needs_clarification",
      errorCode: null,
      safeErrorMessage: null,
    };
    await replyAndRecord(
      ctx,
      parsed.pastLabels.length
        ? [
            `Не поставил: ${parsed.pastLabels.join(", ")} уже прошли для «${session.item.title}».`,
            "Напиши будущее время до события, например: «за 2 часа и за 30 минут».",
          ].join("\n")
        : [
            "Не понял набор напоминаний.",
            "",
            "Напиши так:",
            "• за 2 часа и за 30 минут",
            "• за день в 9 утра, за 2 часа и за 30 минут",
            "• в 7:00 и 7:30",
          ].join("\n"),
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
  let result;
  try {
    result = await applyItemEditMutation({
      userId: owner.id,
      item: session.item,
      mutation,
      timezone,
      sourceMessageId: ctx.dbMessageId,
      now,
    });
  } catch (error) {
    await updateAgentAction({
      userId: owner.id,
      actionId: session.action.id,
      status: "failed",
      output: {
        ...(session.action.output ?? {}),
        activeSessionType: "multi_reminder_setup_session",
        sessionTargetItemId: session.item.id,
        intendedMutation: "before_event_reminder_policy",
        actualMutation: "none",
        routingDecision: "handled_by_multi_reminder_setup_session",
        localMutationSucceeded: false,
        calendarSyncStatus: "not_requested",
        failureReason: "reminder_policy_persist_failed",
        safeErrorMessage:
          error instanceof Error ? error.name || "reminder_policy_persist_failed" : "unknown",
        failedAt: now.toISOString(),
      },
    });
    ctx.deterministicTrace = {
      preRouterIntent: "multi_reminder_setup_session",
      aiRequired: false,
      aiCalled: false,
      aiSucceeded: false,
      structuredOutputValid: true,
      toolCallsProposed: ["create_before_event_policy"],
      toolCallsExecuted: [],
      fallbackUsed: false,
      fallbackReason: null,
      validationWarnings: ["reminder_policy_persist_failed"],
      toolExecutionFailed: "create_before_event_policy",
      toolFailureReason: "reminder_policy_persist_failed",
      toolFailureField: "reminder_offsets",
      suggestedNextPrompt: "Попробуй повторить этот же набор напоминаний.",
      finalAction: "reminder_setup_apply_failed_without_ai",
      errorCode: null,
      safeErrorMessage: "Не смог сохранить напоминания для выбранного события.",
    };
    await replyAndRecord(
      ctx,
      [
        "Не смог сохранить напоминания для выбранного события.",
        "Ничего не отправляю в AI и не создаю новую задачу.",
        "Попробуй повторить этот же набор или нажми /cancel.",
      ].join("\n"),
      { reply_markup: itemMenuKeyboard(session.item.id) },
    );
    return true;
  }
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
  ctx.deterministicTrace = {
    preRouterIntent: "multi_reminder_setup_session",
    aiRequired: false,
    aiCalled: false,
    aiSucceeded: false,
    structuredOutputValid: true,
    toolCallsProposed: ["create_before_event_policy"],
    toolCallsExecuted: ["create_before_event_policy"],
    fallbackUsed: false,
    fallbackReason: null,
    validationWarnings: parsed.pastLabels.map((label) => `before_event_in_past:${label}`),
    finalAction: "multi_reminder_setup_applied",
    createdPolicyIds: result.policyIds,
    createdReminderIds: result.reminderIds,
    updatedItemIds: [session.item.id],
    errorCode: null,
    safeErrorMessage: null,
  };

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

export function formatMultiReminderApplied(
  item: PlannerItem,
  reminders: Array<{ label: string; fireAtLocal: string }>,
  pastLabels: string[],
) {
  const lines = [
    "Готово:",
    `• ${item.title}`,
    `Напоминания добавлены: ${reminders.map((reminder) => reminder.label).join(", ")}.`,
  ];
  if (pastLabels.length) {
    lines.push("", `Не добавил прошедшие: ${pastLabels.join(", ")}.`);
  }
  return lines.join("\n");
}
