import { DateTime } from "luxon";

import type { ReminderPolicy } from "@/db/schema";
import { formatRuWeekdayDateTime } from "@/domain/dateTime";

export function isPersistentReminderPolicy(policy: ReminderPolicy) {
  return (
    policy.policyType === "nag_until_ack" ||
    policy.requireAck ||
    policy.metadata?.stopOnItemComplete === true ||
    policy.metadata?.stopCondition === "until_done"
  );
}

export function formatHumanReminderPolicy(
  policy: ReminderPolicy,
  timezone: string,
  options?: { includeNext?: boolean; now?: Date },
) {
  const interval = policy.intervalMinutes
    ? policy.intervalMinutes === 60
      ? "каждый час"
      : policy.intervalMinutes === 30
        ? "каждые 30 минут"
        : `каждые ${policy.intervalMinutes} мин`
    : null;
  const startClock = policy.startsAt
    ? DateTime.fromJSDate(policy.startsAt, { zone: "utc" })
        .setZone(policy.timezone || timezone)
        .toFormat("HH:mm")
    : String(policy.metadata?.activeWindowStart ?? "");
  const endClock = policy.endsAt
    ? DateTime.fromJSDate(policy.endsAt, { zone: "utc" })
        .setZone(policy.timezone || timezone)
        .toFormat("HH:mm")
    : String(policy.metadata?.activeWindowEnd ?? "");
  const recurrence = humanRecurrence(policy.recurrenceRule);
  const parts = [
    interval ?? recurrence ?? (policy.policyType === "before_event" ? "до события" : "один раз"),
    startClock && endClock ? `с ${startClock} до ${endClock}` : null,
    isPersistentReminderPolicy(policy) ? "пока не отмечу" : null,
  ].filter(Boolean);
  if (options?.includeNext && policy.nextFireAt) {
    parts.push(`следующее: ${formatRuWeekdayDateTime(policy.nextFireAt, policy.timezone || timezone)}`);
  }
  if (policy.snoozedUntil && policy.snoozedUntil > (options?.now ?? new Date())) {
    parts.push(`отложено до ${formatRuWeekdayDateTime(policy.snoozedUntil, policy.timezone || timezone)}`);
  }
  return `${isPersistentReminderPolicy(policy) ? "❗ " : ""}${parts.join(", ")}`;
}

function humanRecurrence(value: string | null) {
  const rule = (value ?? "").toLowerCase();
  if (!rule) return null;
  if (/monthly|month/.test(rule)) return "каждый месяц";
  if (/weekly|week/.test(rule)) return "каждую неделю";
  if (/daily|day/.test(rule)) return "каждый день";
  return "по расписанию";
}
