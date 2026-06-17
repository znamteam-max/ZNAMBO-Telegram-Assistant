import { getPlannerItemById } from "@/db/queries/items";
import { writeAudit } from "@/db/queries/audit";
import {
  createReminderIfMissing,
  getReminderByIdForUser,
  type ClaimedReminder,
} from "@/db/queries/reminders";
import type { PlannerItem, Reminder } from "@/db/schema";
import {
  eventReminderAnchor,
  planSmartExtraEventReminder,
  validEventReminderSnoozeOptions,
} from "@/domain/eventReminderSemantics";

export type EventReminderActionResult =
  | { status: "scheduled"; reminder: Reminder; scheduledAt: Date }
  | { status: "needs_choice"; optionsMinutes: number[] }
  | { status: "not_found" | "not_event" | "too_late" | "no_safe_slot" };

export async function scheduleSmartExtraEventReminder(params: {
  userId: string;
  reminderId: string;
  now?: Date;
}): Promise<EventReminderActionResult> {
  const now = params.now ?? new Date();
  const context = await loadEventReminderContext(params.userId, params.reminderId);
  if (!context) return { status: "not_found" };
  if (!context.item || !["event", "training", "tentative_event"].includes(context.item.kind)) {
    return { status: "not_event" };
  }
  const plan = planSmartExtraEventReminder({ item: context.item, now });
  if (plan.kind === "unavailable") {
    return { status: plan.reason === "event_already_started" ? "too_late" : "no_safe_slot" };
  }
  if (plan.kind === "needs_choice") {
    return plan.optionsMinutes.length
      ? { status: "needs_choice", optionsMinutes: plan.optionsMinutes }
      : { status: "too_late" };
  }
  return scheduleEventReminderOnly({
    userId: params.userId,
    reminder: context.reminder,
    item: context.item,
    scheduledAt: plan.scheduledAt,
    idempotencySuffix: `again:${plan.scheduledAt.toISOString()}`,
  });
}

export async function scheduleManualEventReminderSnooze(params: {
  userId: string;
  reminderId: string;
  minutes: number;
  now?: Date;
}): Promise<EventReminderActionResult> {
  const now = params.now ?? new Date();
  const context = await loadEventReminderContext(params.userId, params.reminderId);
  if (!context) return { status: "not_found" };
  if (!context.item || !["event", "training", "tentative_event"].includes(context.item.kind)) {
    return { status: "not_event" };
  }
  const allowed = validEventReminderSnoozeOptions({
    item: context.item,
    now,
    optionsMinutes: [params.minutes],
  });
  if (!allowed.length) return { status: "too_late" };
  return scheduleEventReminderOnly({
    userId: params.userId,
    reminder: context.reminder,
    item: context.item,
    scheduledAt: new Date(now.getTime() + params.minutes * 60_000),
    idempotencySuffix: `snooze:${params.minutes}`,
  });
}

async function scheduleEventReminderOnly(params: {
  userId: string;
  reminder: ClaimedReminder | Reminder;
  item: PlannerItem;
  scheduledAt: Date;
  idempotencySuffix: string;
}): Promise<EventReminderActionResult> {
  const anchor = eventReminderAnchor(params.item);
  if (!anchor || params.scheduledAt.getTime() >= anchor.getTime()) return { status: "too_late" };
  const reminder = await createReminderIfMissing({
    userId: params.userId,
    plannerItemId: params.item.id,
    type: "event_before",
    idempotencyKey: `${params.reminder.id}:event:${params.idempotencySuffix}`,
    scheduledAt: params.scheduledAt,
    spacingLatestAt: new Date(anchor.getTime() - 60_000),
    repeatUntilAck: false,
    parentReminderId: params.reminder.parentReminderId ?? params.reminder.id,
    purpose: "pre_event_extra",
    menuType: "event_reminder",
    autoDeleteAfterResponse: params.reminder.autoDeleteAfterResponse,
    payload: {
      ...(params.reminder.payload ?? {}),
      eventReminderOnly: true,
      sourceReminderId: params.reminder.id,
      scheduledFor: params.scheduledAt.toISOString(),
    },
  });
  if (reminder) {
    await writeAudit({
      userId: params.userId,
      action: "assistant.event_followup_reminder_created",
      entityType: "reminder",
      entityId: reminder.id,
      details: {
        plannerItemId: params.item.id,
        sourceReminderId: params.reminder.id,
        scheduledAt: reminder.scheduledAt.toISOString(),
        eventTimeUnchanged: true,
      },
    }).catch(() => undefined);
  }
  return reminder
    ? { status: "scheduled", reminder, scheduledAt: reminder.scheduledAt }
    : { status: "no_safe_slot" };
}

async function loadEventReminderContext(userId: string, reminderId: string) {
  const reminder = await getReminderByIdForUser({ userId, reminderId });
  if (!reminder?.plannerItemId) return reminder ? { reminder, item: null } : null;
  const item = await getPlannerItemById(userId, reminder.plannerItemId);
  return { reminder, item };
}
