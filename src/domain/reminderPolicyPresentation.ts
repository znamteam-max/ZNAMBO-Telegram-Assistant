import { DateTime } from "luxon";

import type { PlannerItem, Reminder, ReminderPolicy } from "@/db/schema";
import { formatRuWeekdayDateTime } from "@/domain/dateTime";
import {
  formatRecurringRuleHuman,
  parseCanonicalRecurrenceRule,
} from "@/domain/recurringPolicySemantics";
import { isTodayUntilDoneReminderPolicy } from "@/domain/todayUntilDoneTask";
import { isTechnicalBeforeEventLabel } from "@/domain/reminderIntent";

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
  if (["after_event", "post_event_menu"].includes(policy.policyType)) {
    return !(policy.nextFireAt ?? policy.startsAt ?? item?.endAt ?? item?.startAt ?? item?.dueAt);
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
  const todayUntilDone = formatTodayUntilDonePolicy(policy, timezone, options);
  if (todayUntilDone) return todayUntilDone;
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
  const postEvent = ["after_event", "post_event_menu"].includes(policy.policyType)
    ? formatPostEventPolicy(policy, timezone, options?.item)
    : null;
  const parts = [
    postEvent ||
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

function formatTodayUntilDonePolicy(
  policy: ReminderPolicy,
  timezone: string,
  options?: { includeNext?: boolean; now?: Date; includeMarker?: boolean; item?: PlannerItem },
) {
  if (!isTodayUntilDoneReminderPolicy(policy)) return null;
  const interval = policy.intervalMinutes ? formatInterval(policy.intervalMinutes) : null;
  if (!interval) return null;
  const zone = policy.timezone || options?.item?.timezone || timezone;
  const endClock =
    typeof policy.metadata?.activeWindowEnd === "string" && policy.metadata.activeWindowEnd
      ? policy.metadata.activeWindowEnd
      : policy.endsAt
        ? DateTime.fromJSDate(policy.endsAt, { zone: "utc" }).setZone(zone).toFormat("HH:mm")
        : "23:59";
  const parts: string[] = [];
  const now = options?.now ?? new Date();
  if (policy.snoozedUntil && policy.snoozedUntil > now) {
    const snoozedClock = DateTime.fromJSDate(policy.snoozedUntil, { zone: "utc" })
      .setZone(zone)
      .toFormat("HH:mm");
    parts.push(
      `\u043e\u0442\u043b\u043e\u0436\u0435\u043d\u043e \u0434\u043e ${snoozedClock}`,
      `\u043f\u043e\u0442\u043e\u043c ${interval} \u0434\u043e ${endClock}`,
    );
  } else {
    parts.push(`${interval} \u0434\u043e ${endClock}`);
  }
  parts.push("\u043f\u043e\u043a\u0430 \u043d\u0435 \u043e\u0442\u043c\u0435\u0447\u0443");
  if (options?.includeNext && policy.nextFireAt) {
    parts.push(
      `\u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0435\u0435: ${formatRuWeekdayDateTime(
        policy.nextFireAt,
        zone,
      )}`,
    );
  }
  const marker = options?.includeMarker === false ? "" : "\u2757 ";
  return `${marker}${parts.join(", ")}`;
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
  const morningPolicies: ReminderPolicy[] = [];
  for (const policy of policies) {
    const minutes = getEventLinkedReminderOffsetMinutes(policy, options?.item);
    if (!minutes) continue;
    if (policy.metadata?.eventMorningSet === true) {
      morningPolicies.push(policy);
      continue;
    }
    const key = beforeEventDisplayKey(policy, minutes);
    if (seen.has(key)) continue;
    seen.add(key);
    offsets.push({
      minutes,
      label: formatBeforeEventDisplayLabel(policy, minutes, timezone, options?.item),
    });
  }
  offsets.sort((left, right) => right.minutes - left.minutes);
  const morning = formatMorningEventSetLabel(morningPolicies, timezone, options?.item);
  return [...offsets.map((entry) => entry.label), morning].filter(Boolean).join(", ");
}

export function formatItemReminderPolicyLines(
  policies: ReminderPolicy[],
  timezone: string,
  options: { item: PlannerItem; now?: Date; includeNextBeforeEvent?: boolean },
) {
  const handled = new Set<string>();
  const offsets: Array<{ minutes: number; label: string; deliveryAt?: Date | null }> = [];
  const morningPolicies: ReminderPolicy[] = [];
  for (const policy of policies) {
    const minutes = getEventLinkedReminderOffsetMinutes(policy, options.item);
    if (!minutes) continue;
    if (policy.metadata?.eventMorningSet === true) {
      morningPolicies.push(policy);
      handled.add(policy.id);
      continue;
    }
    const key = beforeEventDisplayKey(policy, minutes);
    if (handled.has(key)) {
      handled.add(policy.id);
      continue;
    }
    handled.add(key);
    handled.add(policy.id);
    offsets.push({
      minutes,
      label: formatBeforeEventDisplayLabel(policy, minutes, timezone, options.item),
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
  const morning = formatMorningEventSetLabel(morningPolicies, timezone, options.item);
  if (morning) lines.push(morning);

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

function beforeEventDisplayKey(policy: ReminderPolicy, minutes: number) {
  if (policy.metadata?.eventMorningSet === true) return "event_morning_set";
  return `relative:${minutes}`;
}

function formatMorningEventSetLabel(
  policies: ReminderPolicy[],
  timezone: string,
  item?: PlannerItem | null,
) {
  if (!policies.length) return null;
  const zone = item?.timezone || policies[0]?.timezone || timezone;
  const times = [
    ...new Set(
      policies
        .map((policy) => policy.nextFireAt ?? policy.startsAt)
        .filter((value): value is Date => Boolean(value))
        .sort((left, right) => left.getTime() - right.getTime())
        .map((value) => DateTime.fromJSDate(value, { zone: "utc" }).setZone(zone).toFormat("HH:mm")),
    ),
  ];
  if (!times.length) return "утром в день события";
  return `утром в день события: ${times.join(", ")}`;
}

function formatBeforeEventDisplayLabel(
  policy: ReminderPolicy,
  minutes: number,
  timezone: string,
  item?: PlannerItem | null,
) {
  const label = policy.metadata?.relativeLabel;
  if (typeof label === "string" && label.trim() && !isTechnicalBeforeEventLabel(label)) {
    return label.trim();
  }
  return formatBeforeEventOffset(
    minutes,
    policy.nextFireAt ?? policy.startsAt,
    policy.timezone || item?.timezone || timezone,
  );
}

export function formatEventFollowupReminderLines(
  reminders: Reminder[],
  timezone: string,
  options: { item: PlannerItem; now?: Date; todayOnly?: boolean },
) {
  const zone = options.item.timezone || timezone;
  const now = options.now ?? new Date();
  const today = DateTime.fromJSDate(now, { zone: "utc" }).setZone(zone);
  const anchor = options.item.startAt ?? options.item.dueAt ?? null;
  return reminders
    .filter((reminder) => isEventFollowupReminder(reminder))
    .filter((reminder) => !anchor || reminder.scheduledAt < anchor)
    .filter((reminder) => {
      if (!options.todayOnly) return true;
      return DateTime.fromJSDate(reminder.scheduledAt, { zone: "utc" })
        .setZone(zone)
        .hasSame(today, "day");
    })
    .sort((left, right) => left.scheduledAt.getTime() - right.scheduledAt.getTime())
    .map((reminder) => {
      const clock = DateTime.fromJSDate(reminder.scheduledAt, { zone: "utc" })
        .setZone(zone)
        .toFormat("HH:mm");
      return `доп. напоминание ${clock}`;
    });
}

export function isEventFollowupReminder(reminder: Reminder) {
  return (
    reminder.purpose === "pre_event_extra" ||
    reminder.payload?.eventReminderOnly === true ||
    reminder.payload?.source === "event_reminder_extra"
  );
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
  if (minutes === 10) return "за десять минут";
  if (minutes === 30) return "за полчаса";
  if (minutes === 60) return "за час";
  if (minutes === 120) return "за 2 часа";
  if (minutes === 2880) return "за 2 дня";
  if (minutes === 4320) return "за 3 дня";
  if (minutes === 10080) return "за неделю";
  if (minutes === 1440) return clock === "09:00" ? "за день в 09:00" : "за день";
  if (minutes > 24 * 60 && minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `за ${days} ${dayWord(days)}`;
  }
  if (minutes > 24 * 60 && minutes <= 48 * 60 && clock) return `за день в ${clock}`;
  if (clock) return `в день визита в ${clock}`;
  return "заранее";
}

function dayWord(days: number) {
  const mod10 = days % 10;
  const mod100 = days % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
  return "дней";
}

function formatBeforeEventPolicy(policy: ReminderPolicy, timezone: string, item?: PlannerItem) {
  const label = policy.metadata?.relativeLabel;
  if (typeof label === "string" && label.trim() && !isTechnicalBeforeEventLabel(label)) return label;
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

function formatPostEventPolicy(policy: ReminderPolicy, timezone: string, item?: PlannerItem) {
  const fireAt = policy.nextFireAt ?? policy.startsAt ?? item?.endAt ?? item?.startAt ?? item?.dueAt;
  const zone = item?.timezone || policy.timezone || timezone;
  if (!fireAt) return null;
  const clock = DateTime.fromJSDate(fireAt, { zone: "utc" }).setZone(zone).toFormat("HH:mm");
  return policy.policyType === "post_event_menu"
    ? `после события — спросить как прошло, ${clock}`
    : `после события, ${clock}`;
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
    if (parsed?.kind === "daily") {
      return formatRecurringRuleHuman("daily");
    }
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
