import { createManualPlannerItem } from "@/db/queries/items";
import { createReminderPolicyIfMissing } from "@/db/queries/reminderPolicies";
import { writeAudit } from "@/db/queries/audit";
import type { PlannerItem, Reminder, ReminderPolicy } from "@/db/schema";
import { localIsoToUtcDate } from "@/domain/dateTime";
import type { IntervalWindowReminderIntent } from "@/domain/intervalWindowReminderIntent";

import { materializeNextPolicyReminder } from "./reminderPolicyEngine";

export type IntervalWindowReminderCreationResult = {
  item: PlannerItem;
  policy: ReminderPolicy;
  reminder: Reminder | null;
};

export async function createIntervalWindowReminderFromIntent(params: {
  userId: string;
  sourceMessageId?: string | null;
  intent: IntervalWindowReminderIntent;
  now: Date;
}): Promise<IntervalWindowReminderCreationResult> {
  const startsAt = localIsoToUtcDate(params.intent.startsAtLocalIso, params.intent.timezone);
  const endsAt = localIsoToUtcDate(params.intent.endsAtLocalIso, params.intent.timezone);
  const idempotencyScope = params.sourceMessageId ?? params.intent.textHash;
  const item = await createManualPlannerItem({
    userId: params.userId,
    kind: "task",
    title: params.intent.title,
    timezone: params.intent.timezone,
    startAt: startsAt,
    dueAt: endsAt,
    category: "reminder",
    visibility: "active",
    metadata: {
      source: params.intent.source,
      sourceTimezone: params.intent.timezone,
      intervalWindowReminder: true,
      windowStartLocal: params.intent.windowStartLocal,
      windowEndLocal: params.intent.windowEndLocal,
      intervalMinutes: params.intent.intervalMinutes,
      textHash: params.intent.textHash,
      sourceMessageId: params.sourceMessageId ?? null,
    },
  });
  const policy = await createReminderPolicyIfMissing({
    userId: params.userId,
    itemId: item.id,
    title: params.intent.title,
    category: "interval_window",
    policyType: "interval_window",
    timezone: params.intent.timezone,
    startsAt,
    endsAt,
    nextFireAt: startsAt,
    intervalMinutes: params.intent.intervalMinutes,
    requireAck: params.intent.requireAck,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    quietHours: { allowDuringQuietHours: true },
    idempotencyKey: [
      "standalone_interval_window",
      params.userId,
      idempotencyScope,
      startsAt.toISOString(),
      params.intent.intervalMinutes,
    ].join(":"),
    metadata: {
      source: params.intent.source,
      sourceTimezone: params.intent.timezone,
      activeWindowStart: params.intent.windowStartLocal,
      activeWindowEnd: params.intent.windowEndLocal,
      intervalMinutes: params.intent.intervalMinutes,
      finiteWindow: true,
      allowDuringQuietHours: true,
      textHash: params.intent.textHash,
      itemId: item.id,
    },
  });
  const reminder =
    startsAt > params.now
      ? await materializeNextPolicyReminder(policy, startsAt, { now: params.now })
      : null;
  await writeAudit({
    userId: params.userId,
    action: "assistant.interval_window_reminder_created",
    entityType: "reminder_policy",
    entityId: policy.id,
    details: {
      itemId: item.id,
      reminderId: reminder?.id ?? null,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      intervalMinutes: params.intent.intervalMinutes,
      timezone: params.intent.timezone,
      source: params.intent.source,
      textHash: params.intent.textHash,
    },
  }).catch(() => undefined);
  return { item, policy, reminder };
}

export function formatIntervalWindowCreationReply(params: {
  result: IntervalWindowReminderCreationResult;
  intent: IntervalWindowReminderIntent;
}) {
  return [
    "Добавил:",
    `${formatDateLabel(params.intent)} ${params.intent.windowStartLocal}–${params.intent.windowEndLocal} · ${params.result.item.title}`,
    `Напоминания: каждые ${params.intent.intervalMinutes} мин с ${params.intent.windowStartLocal} до ${params.intent.windowEndLocal}`,
  ].join("\n");
}

function formatDateLabel(intent: IntervalWindowReminderIntent) {
  if (intent.dateLabel === "сегодня") return "Сегодня";
  if (intent.dateLabel === "завтра") return "Завтра";
  return intent.dateLocal;
}
