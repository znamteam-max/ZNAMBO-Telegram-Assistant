import { DateTime } from "luxon";

import type { PlannerItem, ReminderPolicy } from "@/db/schema";
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

export function isReminderPolicyReviewRequired(policy: ReminderPolicy, item?: PlannerItem | null) {
  if (policy.metadata?.reviewRequired === true || policy.metadata?.needsReview === true) {
    return true;
  }
  if (policy.policyType === "before_event") {
    return !getBeforeEventPolicyKey(policy, item);
  }
  if (!item || policy.itemId !== item.id) return false;
  if (!["event", "training", "tentative_event"].includes(item.kind)) return false;
  if (!["one_time", "custom"].includes(policy.policyType)) return false;
  if (policy.recurrenceRule || policy.intervalMinutes) return false;
  return !getEventLinkedReminderOffsetMinutes(policy, item);
}

export function formatHumanReminderPolicy(
  policy: ReminderPolicy,
  timezone: string,
  options?: { includeNext?: boolean; now?: Date; includeMarker?: boolean; item?: PlannerItem },
) {
  const concreteOneTime = formatConcreteOneTimePolicy(policy, timezone, {
    item: options?.item,
    now: options?.now,
  });
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
  const beforeEvent =
    policy.policyType === "before_event"
      ? formatBeforeEventPolicy(policy, timezone, options?.item)
      : null;
  const parts = [
    beforeEvent ||
      concreteOneTime ||
      [recurrence, interval].filter(Boolean).join(", ") ||
      (policy.policyType === "before_event"
        ? formatReminderNeedsReview("напоминание перед событием")
        : formatReminderNeedsReview("напоминание")),
    startClock && endClock ? `с ${startClock} до ${endClock}` : null,
    isPersistentReminderPolicy(policy) ? "пока не отмечу" : null,
  ].filter(Boolean);
  if (options?.includeNext && policy.nextFireAt) {
    parts.push(
      `следующее: ${formatRuWeekdayDateTime(policy.nextFireAt, policy.timezone || timezone)}`,
    );
  }
  if (policy.snoozedUntil && policy.snoozedUntil > (options?.now ?? new Date())) {
    parts.push(
      `отложено до ${formatRuWeekdayDateTime(policy.snoozedUntil, policy.timezone || timezone)}`,
    );
  }
  return `${options?.includeMarker === false || !isPersistentReminderPolicy(policy) ? "" : "❗ "}${parts.join(", ")}`;
}

export function getBeforeEventOffsetMinutes(policy: ReminderPolicy, item?: PlannerItem | null) {
  if (policy.policyType !== "before_event") return null;
  const metadataMinutes = Number(policy.metadata?.minutesBefore);
  if (Number.isFinite(metadataMinutes) && metadataMinutes > 0) {
    return Math.round(metadataMinutes);
  }
  const anchor = item?.startAt ?? item?.dueAt ?? null;
  const fireAt = policy.nextFireAt ?? policy.startsAt ?? null;
  if (!anchor || !fireAt) return null;
  const minutes = Math.round((anchor.getTime() - fireAt.getTime()) / 60_000);
  return minutes > 0 ? minutes : null;
}

export function getEventLinkedReminderOffsetMinutes(
  policy: ReminderPolicy,
  item?: PlannerItem | null,
) {
  if (policy.policyType === "before_event") return getBeforeEventOffsetMinutes(policy, item);
  if (!item || policy.itemId !== item.id) return null;
  if (policy.recurrenceRule || policy.intervalMinutes) return null;
  if (!["one_time", "custom"].includes(policy.policyType)) return null;
  const anchor = item.startAt ?? item.dueAt ?? null;
  const fireAt = policy.nextFireAt ?? policy.startsAt ?? null;
  if (!anchor || !fireAt) return null;
  const minutes = Math.round((anchor.getTime() - fireAt.getTime()) / 60_000);
  return minutes > 0 ? minutes : null;
}

export function getBeforeEventPolicyKey(policy: ReminderPolicy, item?: PlannerItem | null) {
  const minutes = getEventLinkedReminderOffsetMinutes(policy, item);
  return minutes ? `relative:${minutes}` : null;
}

export function formatDedupedBeforeEventPolicies(
  policies: ReminderPolicy[],
  timezone: string,
  options?: { item?: PlannerItem | null },
) {
  const seen = new Set<string>();
  const offsets: Array<{ minutes: number; label: string }> = [];
  for (const policy of policies) {
    const minutes = getEventLinkedReminderOffsetMinutes(policy, options?.item);
    if (!minutes) continue;
    const key = `relative:${minutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    offsets.push({
      minutes,
      label: formatBeforeEventOffset(
        minutes,
        policy.nextFireAt ?? policy.startsAt,
        policy.timezone || options?.item?.timezone || timezone,
      ),
    });
  }
  offsets.sort((left, right) => right.minutes - left.minutes);
  return offsets.map((entry) => entry.label).join(", ");
}

export function formatItemReminderPolicyLines(
  policies: ReminderPolicy[],
  timezone: string,
  options: { item: PlannerItem; now?: Date; includeNextBeforeEvent?: boolean },
) {
  const handled = new Set<string>();
  const offsets: Array<{ minutes: number; label: string; deliveryAt?: Date | null }> = [];
  for (const policy of policies) {
    const minutes = getEventLinkedReminderOffsetMinutes(policy, options.item);
    if (!minutes) continue;
    const key = `relative:${minutes}`;
    if (handled.has(key)) {
      handled.add(policy.id);
      continue;
    }
    handled.add(key);
    handled.add(policy.id);
    offsets.push({
      minutes,
      label: formatBeforeEventOffset(
        minutes,
        policy.nextFireAt ?? policy.startsAt,
        policy.timezone || options.item.timezone || timezone,
      ),
      deliveryAt: policy.nextFireAt ?? policy.startsAt,
    });
  }
  offsets.sort((left, right) => right.minutes - left.minutes);

  const lines = offsets.map((entry) => {
    if (!options.includeNextBeforeEvent || !entry.deliveryAt) return entry.label;
    const fire = DateTime.fromJSDate(entry.deliveryAt, { zone: "utc" }).setZone(
      options.item.timezone || timezone,
    );
    return fire.isValid
      ? `${entry.label}, следующее: ${fire.toFormat("dd.LL HH:mm")}`
      : entry.label;
  });

  for (const policy of policies) {
    if (handled.has(policy.id)) continue;
    if (isReminderPolicyReviewRequired(policy, options.item)) continue;
    const formatted = formatHumanReminderPolicy(policy, timezone, {
      now: options.now,
      includeMarker: false,
      includeNext: policy.policyType === "before_event",
      item: options.item,
    });
    if (!formatted || lines.includes(formatted)) continue;
    lines.push(formatted);
  }

  return lines;
}

export function formatBeforeEventOffset(
  minutes: number,
  deliveryAt?: Date | null,
  timezone?: string,
) {
  const clock =
    deliveryAt && timezone
      ? DateTime.fromJSDate(deliveryAt, { zone: "utc" }).setZone(timezone).toFormat("HH:mm")
      : null;
  if (minutes === 10) return "за 10 минут";
  if (minutes === 30) return "за 30 минут";
  if (minutes === 60) return "за час";
  if (minutes === 120) return "за 2 часа";
  if (minutes === 1440) return clock === "09:00" ? "за день в 09:00" : "за день";
  if (minutes > 24 * 60 && minutes <= 48 * 60 && clock) return `за день в ${clock}`;
  if (minutes % 60 === 0) return `за ${minutes / 60} ч`;
  return `за ${minutes} минут`;
}

function formatBeforeEventPolicy(policy: ReminderPolicy, timezone: string, item?: PlannerItem) {
  const label = policy.metadata?.relativeLabel;
  if (typeof label === "string" && label.trim()) return label;
  const metadataMinutes = Number(policy.metadata?.minutesBefore);
  if (Number.isFinite(metadataMinutes) && metadataMinutes > 0) {
    return formatBeforeEventOffset(
      Math.round(metadataMinutes),
      policy.nextFireAt ?? policy.startsAt,
      policy.timezone || timezone,
    );
  }
  const anchor = item?.startAt ?? item?.dueAt ?? null;
  const fireAt = policy.nextFireAt ?? policy.startsAt ?? null;
  if (anchor && fireAt) {
    const minutes = Math.round((anchor.getTime() - fireAt.getTime()) / 60_000);
    if (minutes > 0) {
      return formatBeforeEventOffset(
        minutes,
        fireAt,
        item?.timezone || policy.timezone || timezone,
      );
    }
  }
  return null;
}

function formatConcreteOneTimePolicy(
  policy: ReminderPolicy,
  timezone: string,
  options?: { item?: PlannerItem; now?: Date },
) {
  if (policy.policyType !== "one_time" && policy.policyType !== "custom") return null;
  const item = options?.item;
  const eventOffset = getEventLinkedReminderOffsetMinutes(policy, item);
  if (eventOffset) {
    return formatBeforeEventOffset(
      eventOffset,
      policy.nextFireAt ?? policy.startsAt,
      item?.timezone || policy.timezone || timezone,
    );
  }
  const fireAt = policy.nextFireAt ?? policy.startsAt ?? null;
  if (!fireAt) return null;
  const zone = policy.timezone || item?.timezone || timezone;
  const local = DateTime.fromJSDate(fireAt, { zone: "utc" }).setZone(zone);
  const today = DateTime.fromJSDate(options?.now ?? new Date(), { zone: "utc" })
    .setZone(zone)
    .startOf("day");
  if (local.hasSame(today, "day")) return `сегодня в ${local.toFormat("HH:mm")}`;
  if (local.hasSame(today.plus({ days: 1 }), "day")) return `завтра в ${local.toFormat("HH:mm")}`;
  return formatRuWeekdayDateTime(fireAt, zone);
}

function formatReminderNeedsReview(subject: string) {
  return `${subject} требует проверки: нужно уточнить время, не понял, когда сработать`;
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
