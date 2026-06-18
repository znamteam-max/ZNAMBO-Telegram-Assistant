import { writeAudit } from "@/db/queries/audit";
import { createManualPlannerItem } from "@/db/queries/items";
import { createReminderPolicyIfMissing } from "@/db/queries/reminderPolicies";
import { formatRuWeekdayDateRange } from "@/domain/dateTime";
import {
  localIsoToDate,
  type ScheduledCreationIntent,
} from "@/domain/scheduledCreationIntent";
import { formatCalendarSyncFeedback, syncItemsToCalendarBestEffort } from "@/services/calendarBestEffort";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";

export type ScheduledCreationResult = {
  item: Awaited<ReturnType<typeof createManualPlannerItem>>;
  policyIds: string[];
  reminderIds: string[];
  calendarFeedback: string | null;
};

export async function createScheduledItemFromIntent(params: {
  userId: string;
  sourceMessageId?: string | null;
  intent: ScheduledCreationIntent;
  now?: Date;
}): Promise<ScheduledCreationResult> {
  const startAt = localIsoToDate(params.intent.startLocal, params.intent.timezone);
  const endAt = localIsoToDate(params.intent.endLocal, params.intent.timezone);
  const item = await createManualPlannerItem({
    userId: params.userId,
    kind: params.intent.kind,
    title: params.intent.title,
    timezone: params.intent.timezone,
    startAt,
    endAt,
    dueAt: null,
    category: params.intent.kind === "training" ? "training" : "event",
    metadata: {
      sourceNormalization: "scheduled_creation_intent_v2230",
      sourceTimezone: params.intent.timezone,
      remindersSuppressedByUser: params.intent.remindersSuppressedByUser,
      warnings: params.intent.warnings,
    },
  });

  const policyIds: string[] = [];
  const reminderIds: string[] = [];
  for (const reminder of params.intent.reminders) {
    const fireAt = localIsoToDate(reminder.fireAtLocal, params.intent.timezone);
    const policy = await createReminderPolicyIfMissing({
      userId: params.userId,
      itemId: item.id,
      title: item.title,
      category: "pre_event",
      policyType: "before_event",
      timezone: item.timezone,
      startsAt: fireAt,
      nextFireAt: fireAt,
      requireAck: false,
      catchUpMode: "one_immediate_then_resume",
      idempotencyKey: [
        "scheduled_creation_v2230",
        item.id,
        reminder.minutesBefore,
        fireAt.toISOString(),
      ].join(":"),
      metadata: {
        sourceNormalization: "scheduled_creation_intent_v2230",
        minutesBefore: reminder.minutesBefore,
        relativeLabel: reminder.label,
        basePriority: item.priority,
      },
    });
    policyIds.push(policy.id);
    const materialized = await materializeNextPolicyReminder(policy, fireAt, {
      now: params.now ?? new Date(),
    });
    if (materialized) reminderIds.push(materialized.id);
  }

  const calendarFeedback = formatCalendarSyncFeedback(
    await syncItemsToCalendarBestEffort([item]).catch(() => []),
  );
  await writeAudit({
    userId: params.userId,
    action: "assistant.scheduled_creation_intent_created",
    entityType: "planner_item",
    entityId: item.id,
    details: {
      sourceMessageId: params.sourceMessageId ?? null,
      policyCount: policyIds.length,
      reminderCount: reminderIds.length,
      remindersSuppressedByUser: params.intent.remindersSuppressedByUser,
      calendarAttempted: ["event", "training"].includes(item.kind),
      warnings: params.intent.warnings,
    },
  }).catch(() => undefined);

  return { item, policyIds, reminderIds, calendarFeedback };
}

export function formatScheduledCreationReply(params: {
  result: ScheduledCreationResult;
  intent: ScheduledCreationIntent;
}) {
  const reminderLine = params.intent.remindersSuppressedByUser
    ? "Напоминания: нет"
    : params.intent.reminders.length
      ? `Напоминания: ${params.intent.reminders.map((reminder) => reminder.label).join(", ")}`
      : "Напоминания: нет";
  return [
    "Добавил:",
    `${params.result.item.title} — ${formatRuWeekdayDateRange(
      params.result.item.startAt,
      params.result.item.endAt,
      params.result.item.timezone,
    )}`,
    reminderLine,
    params.result.calendarFeedback,
  ]
    .filter(Boolean)
    .join("\n");
}
