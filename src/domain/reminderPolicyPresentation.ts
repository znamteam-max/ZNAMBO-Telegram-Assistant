import { DateTime } from "luxon";

import type { ReminderPolicy } from "@/db/schema";
import { formatRuWeekdayDateTime } from "@/domain/dateTime";
import {
  formatRecurringRuleHuman,
  parseCanonicalRecurrenceRule,
} from "@/domain/recurringPolicySemantics";

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
  options?: { includeNext?: boolean; now?: Date; includeMarker?: boolean },
) {
  const interval = policy.intervalMinutes ? formatInterval(policy.intervalMinutes) : null;
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
  const recurrence = humanRecurrence(policy.recurrenceRule, Boolean(interval));
  const parts = [
    [recurrence, interval].filter(Boolean).join(", ") ||
      (policy.policyType === "before_event" ? "до события" : "один раз"),
    startClock && endClock ? `с ${startClock} до ${endClock}` : null,
    isPersistentReminderPolicy(policy) ? "пока не отмечу" : null,
  ].filter(Boolean);
  if (options?.includeNext && policy.nextFireAt) {
    parts.push(`следующее: ${formatRuWeekdayDateTime(policy.nextFireAt, policy.timezone || timezone)}`);
  }
  if (policy.snoozedUntil && policy.snoozedUntil > (options?.now ?? new Date())) {
    parts.push(`отложено до ${formatRuWeekdayDateTime(policy.snoozedUntil, policy.timezone || timezone)}`);
  }
  return `${options?.includeMarker === false || !isPersistentReminderPolicy(policy) ? "" : "❗ "}${parts.join(", ")}`;
}

function formatInterval(minutes: number) {
  if (minutes === 60) return "каждый час";
  if (minutes === 30) return "каждые 30 минут";
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours === 1) return "каждый час";
    if (hours >= 2 && hours <= 4) return `каждые ${hours} часа`;
    return `каждые ${hours} часов`;
  }
  return `каждые ${minutes} мин`;
}

function humanRecurrence(value: string | null, omitTime = false) {
  if (omitTime) {
    const parsed = parseCanonicalRecurrenceRule(value);
    if (parsed?.kind === "weekly") {
      return formatRecurringRuleHuman(`weekly:${parsed.weekday}`);
    }
    if (parsed?.kind === "monthly_day_range") {
      return formatRecurringRuleHuman(`monthly_days:${parsed.monthDays.join(",")}`);
    }
  }
  const canonical = formatRecurringRuleHuman(value);
  if (canonical) return canonical;
  const rule = (value ?? "").toLowerCase();
  if (!rule) return null;
  if (/monthly|month/.test(rule)) return "каждый месяц";
  if (/weekly|week/.test(rule)) return "каждую неделю";
  if (/daily|day/.test(rule)) return "каждый день";
  return "по расписанию";
}
