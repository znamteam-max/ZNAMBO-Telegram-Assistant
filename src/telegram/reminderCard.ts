import type { InlineKeyboard } from "grammy";

import { formatReminderMessage } from "@/bot/formatters";
import {
  actionableReminderActions,
  actionableReminderKeyboard,
  eventReactionKeyboard,
  eventReminderMenuKeyboard,
  normalReminderMenuKeyboard,
  singleItemManagementKeyboard,
  tentativeEventFollowupKeyboard,
  type ActionableReminderAction,
} from "@/bot/keyboards";
import { getPlannerItemByAnyId } from "@/db/queries/items";
import { getReminderPolicyById } from "@/db/queries/reminderPolicies";
import { getReminderByIdForUser } from "@/db/queries/reminders";
import type { PlannerItem, Reminder, ReminderPolicy } from "@/db/schema";
import { isEventLikePlannerItem } from "@/domain/eventReminderSemantics";
import { isTodayUntilDonePlannerItem } from "@/domain/todayUntilDoneTask";

export type ReminderCardMode =
  | "task_until_done"
  | "monthly_occurrence"
  | "recurring_rule"
  | "event_reminder"
  | "post_event_menu"
  | "snooze"
  | "management"
  | "normal";

export type ActionableReminderCard = {
  text: string;
  keyboard?: InlineKeyboard;
  renderMode: ReminderCardMode;
  allowedActions: ActionableReminderAction[];
  buttonsAttached: boolean;
  item: PlannerItem | null;
  policy: ReminderPolicy | null;
  reminder: Reminder;
};

export type ReminderCardResolution =
  | { status: "ready"; card: ActionableReminderCard }
  | { status: "cancel"; reason: string }
  | { status: "stale"; reason: string; text: string };

export async function resolveActionableReminderCard(params: {
  userId: string;
  reminderId: string;
  now?: Date;
}): Promise<ReminderCardResolution> {
  const now = params.now ?? new Date();
  const reminder = await getReminderByIdForUser({
    userId: params.userId,
    reminderId: params.reminderId,
  });
  if (!reminder) return { status: "cancel", reason: "reminder_not_found" };
  if (["acked", "cancelled", "failed"].includes(reminder.status)) {
    return { status: "cancel", reason: `reminder_${reminder.status}` };
  }

  const [item, policy] = await Promise.all([
    reminder.plannerItemId ? getPlannerItemByAnyId(reminder.plannerItemId) : null,
    reminder.policyId ? getReminderPolicyById(reminder.policyId) : null,
  ]);
  if (item && ["completed", "cancelled", "archived"].includes(item.status)) {
    return { status: "cancel", reason: `item_${item.status}` };
  }
  if (policy && policy.status !== "active") {
    return { status: "cancel", reason: `policy_${policy.status}` };
  }
  if (policy?.snoozedUntil && policy.snoozedUntil > now) {
    return { status: "cancel", reason: "policy_snoozed" };
  }
  if (!item && reminder.plannerItemId) {
    return {
      status: "stale",
      reason: "item_not_found",
      text: "Напоминание изменилось. Открой план, чтобы увидеть актуальное состояние.",
    };
  }

  return {
    status: "ready",
    card: renderActionableReminderCard({ reminder, item, policy, now }),
  };
}

export function renderActionableReminderCard(params: {
  reminder: Reminder;
  item?: PlannerItem | null;
  policy?: ReminderPolicy | null;
  now?: Date;
}): ActionableReminderCard {
  const now = params.now ?? new Date();
  const item = params.item ?? null;
  const policy = params.policy ?? null;
  const renderMode = reminderCardMode(params.reminder, item, policy);
  const text = isPostEventReminder(params.reminder) && item
    ? item.kind === "training"
      ? `Тренировка «${item.title}» завершилась. Что делаем?`
      : `Событие «${item.title}» завершилось. Что делаем?`
    : formatReminderMessage(params.reminder, item, { policy, now });

  let keyboard: InlineKeyboard | undefined;
  let allowedActions: ActionableReminderAction[] = [];
  if (renderMode === "post_event_menu" && item) {
    keyboard = eventReactionKeyboard(item.id, item.kind);
  } else if (renderMode === "event_reminder" && item) {
    keyboard = eventReminderMenuKeyboard(params.reminder.id, item, now);
  } else if (
    policy ||
    params.reminder.repeatUntilAck ||
    item?.kind === "recurring_task" ||
    isTodayUntilDonePlannerItem(item)
  ) {
    allowedActions = actionableReminderActions({
      policy,
      now,
      timezone: item?.timezone ?? policy?.timezone,
    });
    keyboard = actionableReminderKeyboard({
      reminderId: params.reminder.id,
      plannerItemId: item?.id ?? params.reminder.plannerItemId,
      policy,
      now,
      timezone: item?.timezone ?? policy?.timezone,
    });
  } else if (params.reminder.type === "followup" && item?.kind === "tentative_event") {
    keyboard = tentativeEventFollowupKeyboard(item.id);
  } else if (item?.metadata?.managementButtonsRequested === true) {
    keyboard = singleItemManagementKeyboard(item.id);
  } else if (item) {
    keyboard = normalReminderMenuKeyboard(params.reminder.id, item.id);
  }

  return {
    text,
    keyboard,
    renderMode,
    allowedActions,
    buttonsAttached: Boolean(keyboard),
    item,
    policy,
    reminder: params.reminder,
  };
}

function reminderCardMode(
  reminder: Reminder,
  item: PlannerItem | null,
  policy: ReminderPolicy | null,
): ReminderCardMode {
  if (isPostEventReminder(reminder)) return "post_event_menu";
  if (item && isEventLikePlannerItem(item)) return "event_reminder";
  if (reminder.purpose === "snooze") return "snooze";
  if (policy?.recurrenceRule?.startsWith("monthly_days:")) return "monthly_occurrence";
  if (policy?.recurrenceRule) return "recurring_rule";
  if (policy?.policyType === "nag_until_ack" || isTodayUntilDonePlannerItem(item)) {
    return "task_until_done";
  }
  if (item?.metadata?.managementButtonsRequested === true) return "management";
  return "normal";
}

function isPostEventReminder(reminder: Reminder) {
  return (
    reminder.purpose === "post_event_menu" ||
    reminder.menuType === "event_reaction" ||
    ["followup", "training_followup", "after_event"].includes(reminder.type)
  );
}
