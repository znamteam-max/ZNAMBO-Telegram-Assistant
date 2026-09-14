import { DateTime } from "luxon";

import {
  createManualPlannerItem,
  listManageableItems,
  updatePlannerItemDetails,
} from "@/db/queries/items";
import {
  createReminderPolicyIfMissing,
  listReminderPoliciesForItem,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelPendingRemindersForPolicy } from "@/db/queries/reminders";
import { writeAudit } from "@/db/queries/audit";
import type { PlannerItem, Reminder, ReminderPolicy } from "@/db/schema";
import type { WeeklyTaskReminderIntent } from "@/domain/weeklyTaskReminderIntent";

import { materializeNextPolicyReminder } from "./reminderPolicyEngine";

const WEEKDAY_NUMBERS: Record<WeeklyTaskReminderIntent["weekday"], number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};

export type WeeklyTaskReminderCreationResult = {
  item: PlannerItem;
  policy: ReminderPolicy;
  reminder: Reminder | null;
  updatedExisting: boolean;
};

export function resolveWeeklyTaskCycle(params: {
  intent: WeeklyTaskReminderIntent;
  now: Date;
}) {
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.intent.timezone);
  const targetWeekday = WEEKDAY_NUMBERS[params.intent.weekday];
  const [startHour, startMinute] = parseClock(params.intent.reminderStartLocal);
  const [endHour, endMinute] = parseClock(params.intent.reminderEndLocal);
  const [deadlineHour, deadlineMinute] = parseClock(params.intent.deadlineLocal);

  const daysAhead = (targetWeekday - nowLocal.weekday + 7) % 7;
  let cycleStart = nowLocal
    .plus({ days: daysAhead })
    .startOf("day")
    .set({ hour: startHour, minute: startMinute, second: 0, millisecond: 0 });
  let windowEnd = cycleStart
    .startOf("day")
    .set({ hour: endHour, minute: endMinute, second: 0, millisecond: 0 });
  if (windowEnd < cycleStart) windowEnd = windowEnd.plus({ days: 1 });

  if (daysAhead === 0 && nowLocal > windowEnd) {
    cycleStart = cycleStart.plus({ days: 7 });
    windowEnd = windowEnd.plus({ days: 7 });
  }

  let nextFire = cycleStart;
  if (nowLocal >= cycleStart && nowLocal <= windowEnd) {
    const intervalMs = params.intent.intervalMinutes * 60_000;
    const elapsedMs = Math.max(0, nowLocal.toMillis() - cycleStart.toMillis());
    const steps = Math.floor(elapsedMs / intervalMs) + 1;
    const candidate = cycleStart.plus({ milliseconds: steps * intervalMs });
    if (candidate <= windowEnd) nextFire = candidate;
    else {
      cycleStart = cycleStart.plus({ days: 7 });
      windowEnd = windowEnd.plus({ days: 7 });
      nextFire = cycleStart;
    }
  }

  // Derive the per-occurrence deadline from the final cycle date. The cycle can roll
  // forward by a week when the current Friday window has already ended.
  const deadline = cycleStart
    .startOf("day")
    .set({ hour: deadlineHour, minute: deadlineMinute, second: 0, millisecond: 0 });

  return {
    cycleStart: cycleStart.toUTC().toJSDate(),
    windowEnd: windowEnd.toUTC().toJSDate(),
    deadline: deadline.toUTC().toJSDate(),
    nextFireAt: nextFire.toUTC().toJSDate(),
  };
}

export async function createOrUpdateWeeklyTaskReminderFromIntent(params: {
  userId: string;
  sourceMessageId?: string | null;
  intent: WeeklyTaskReminderIntent;
  now: Date;
}): Promise<WeeklyTaskReminderCreationResult> {
  const timing = resolveWeeklyTaskCycle({ intent: params.intent, now: params.now });
  const activeItems = await listManageableItems(params.userId, 300);
  const exactMatches = activeItems.filter(
    (item) => normalizeTitle(item.title) === normalizeTitle(params.intent.title),
  );
  if (exactMatches.length > 1) {
    throw new Error(`Multiple active planner items match recurring title: ${params.intent.title}`);
  }

  const itemMetadata = {
    source: params.intent.source,
    sourceMessageId: params.sourceMessageId ?? null,
    recurringParentPersistent: true,
    recurringParentCompletionMode: "occurrence_only",
    recurrenceRule: params.intent.recurrenceRule,
    recurringOccurrenceDeadlineTime: params.intent.deadlineLocal,
    activeWindowStart: params.intent.reminderStartLocal,
    activeWindowEnd: params.intent.reminderEndLocal,
    intervalMinutes: params.intent.intervalMinutes,
    stopCondition: params.intent.requireAck ? "until_done" : null,
  };

  const existing = exactMatches[0] ?? null;
  const item = existing
    ? ((await updatePlannerItemDetails({
        userId: params.userId,
        itemId: existing.id,
        kind: "recurring_task",
        title: params.intent.title,
        timezone: params.intent.timezone,
        dueAt: timing.deadline,
        category: existing.category ?? "content",
        visibility: "long_term",
        metadata: itemMetadata,
      })) ?? existing)
    : await createManualPlannerItem({
        userId: params.userId,
        kind: "recurring_task",
        title: params.intent.title,
        timezone: params.intent.timezone,
        dueAt: timing.deadline,
        category: "content",
        visibility: "long_term",
        priority: 3,
        metadata: itemMetadata,
      });

  const policies = await listReminderPoliciesForItem(params.userId, item.id, 100);
  const existingPolicy =
    policies.find(
      (policy) => policy.status === "active" && ["recurring", "long_term"].includes(policy.policyType),
    ) ??
    policies.find((policy) => ["recurring", "long_term"].includes(policy.policyType)) ??
    null;

  const policyMetadata = {
    source: params.intent.source,
    sourceMessageId: params.sourceMessageId ?? null,
    activeWindowStart: params.intent.reminderStartLocal,
    activeWindowEnd: params.intent.reminderEndLocal,
    intervalMinutes: params.intent.intervalMinutes,
    recurringOccurrenceDeadlineTime: params.intent.deadlineLocal,
    recurringParentPersistent: true,
    stopOnItemComplete: false,
    stopCondition: params.intent.requireAck ? "until_done" : null,
    recurrenceRuleVersion: "canonical-weekly-task-v308",
  };

  let policy: ReminderPolicy | null = null;
  if (existingPolicy) {
    await cancelPendingRemindersForPolicy({
      userId: params.userId,
      policyId: existingPolicy.id,
      from: new Date(0),
    });
    policy = await updateReminderPolicy({
      userId: params.userId,
      policyId: existingPolicy.id,
      itemId: item.id,
      status: "active",
      title: params.intent.title,
      category: "content",
      policyType: "recurring",
      startsAt: timing.cycleStart,
      endsAt: null,
      nextFireAt: timing.nextFireAt,
      recurrenceRule: params.intent.recurrenceRule,
      intervalMinutes: params.intent.intervalMinutes,
      requireAck: params.intent.requireAck,
      windowEndInclusive: true,
      catchUpMode: "one_immediate_then_resume",
      onWindowEnd: "expire_silently",
      snoozedUntil: null,
      snoozeScope: null,
      quietHours: { allowDuringQuietHours: true },
      metadata: policyMetadata,
    });
  }

  if (!policy) {
    policy = await createReminderPolicyIfMissing({
      userId: params.userId,
      itemId: item.id,
      title: params.intent.title,
      category: "content",
      policyType: "recurring",
      timezone: params.intent.timezone,
      startsAt: timing.cycleStart,
      endsAt: null,
      nextFireAt: timing.nextFireAt,
      recurrenceRule: params.intent.recurrenceRule,
      intervalMinutes: params.intent.intervalMinutes,
      requireAck: params.intent.requireAck,
      windowEndInclusive: true,
      catchUpMode: "one_immediate_then_resume",
      onWindowEnd: "expire_silently",
      quietHours: { allowDuringQuietHours: true },
      idempotencyKey: [
        "weekly_task_reminder",
        params.userId,
        item.id,
        params.intent.recurrenceRule,
        params.intent.reminderEndLocal,
        params.intent.deadlineLocal,
      ].join(":"),
      metadata: policyMetadata,
    });
  }

  const reminder = await materializeNextPolicyReminder(policy, timing.nextFireAt, { now: params.now });

  await writeAudit({
    userId: params.userId,
    action: "assistant.weekly_task_reminder_created",
    entityType: "reminder_policy",
    entityId: policy.id,
    details: {
      itemId: item.id,
      updatedExisting: Boolean(existing),
      recurrenceRule: params.intent.recurrenceRule,
      intervalMinutes: params.intent.intervalMinutes,
      reminderWindowStart: params.intent.reminderStartLocal,
      reminderWindowEnd: params.intent.reminderEndLocal,
      occurrenceDeadlineTime: params.intent.deadlineLocal,
      nextFireAt: timing.nextFireAt.toISOString(),
      nextDeadlineAt: timing.deadline.toISOString(),
      reminderId: reminder?.id ?? null,
    },
  }).catch(() => undefined);

  return { item, policy, reminder, updatedExisting: Boolean(existing) };
}

export function formatWeeklyTaskReminderCreationReply(params: {
  result: WeeklyTaskReminderCreationResult;
  intent: WeeklyTaskReminderIntent;
}) {
  const weekday = weekdayLabel(params.intent.weekday);
  return [
    params.result.updatedExisting ? "Обновил правило:" : "Добавил правило:",
    `${weekday} · ${params.intent.title}`,
    `Дедлайн каждого повтора: ${params.intent.deadlineLocal}`,
    `Напоминания: ${formatCadence(params.intent.intervalMinutes)} с ${params.intent.reminderStartLocal} до ${params.intent.reminderEndLocal}${params.intent.requireAck ? ", пока не отметишь выполненным" : ""}.`,
  ].join("\n");
}

function weekdayLabel(weekday: WeeklyTaskReminderIntent["weekday"]) {
  return {
    MO: "Каждый понедельник",
    TU: "Каждый вторник",
    WE: "Каждую среду",
    TH: "Каждый четверг",
    FR: "Каждую пятницу",
    SA: "Каждую субботу",
    SU: "Каждое воскресенье",
  }[weekday];
}

function formatCadence(minutes: number) {
  if (minutes === 60) return "каждый час";
  if (minutes % 60 === 0) return `каждые ${minutes / 60} ч`;
  return `каждые ${minutes} мин`;
}

function parseClock(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) throw new Error(`Invalid clock: ${value}`);
  return [hour, minute] as const;
}

function normalizeTitle(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
