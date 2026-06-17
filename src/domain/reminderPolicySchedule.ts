import { DateTime } from "luxon";

import type { ReminderPolicy } from "@/db/schema";
import {
  nextRecurringOccurrence,
  parseCanonicalRecurrenceRule,
} from "@/domain/recurringPolicySemantics";

const WEEKDAY_NUMBERS: Record<string, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};

export type ReconcileTarget = {
  scheduledFor: Date;
  deliveryAt: Date;
  catchUp: boolean;
};

export function nextGridSlot(params: {
  anchor: Date;
  intervalMinutes: number;
  after: Date;
  endsAt?: Date | null;
  inclusiveEnd?: boolean;
}) {
  const intervalMs = params.intervalMinutes * 60 * 1000;
  const elapsed = params.after.getTime() - params.anchor.getTime();
  const steps = elapsed < 0 ? 0 : Math.floor(elapsed / intervalMs) + 1;
  const candidate = new Date(params.anchor.getTime() + steps * intervalMs);
  if (!params.endsAt) return candidate;
  if (params.inclusiveEnd !== false) {
    return candidate <= params.endsAt ? candidate : null;
  }
  return candidate < params.endsAt ? candidate : null;
}

export function planPolicySnooze(params: {
  anchor: Date;
  intervalMinutes: number;
  now: Date;
  snoozeMinutes: number;
  endsAt?: Date | null;
  inclusiveEnd?: boolean;
}) {
  const snoozeAt = new Date(params.now.getTime() + params.snoozeMinutes * 60 * 1000);
  if (
    params.endsAt &&
    (params.inclusiveEnd !== false ? snoozeAt > params.endsAt : snoozeAt >= params.endsAt)
  ) {
    return { snoozeAt: null, nextRegularAt: null };
  }
  return {
    snoozeAt,
    nextRegularAt: nextGridSlot({
      anchor: params.anchor,
      intervalMinutes: params.intervalMinutes,
      after: snoozeAt,
      endsAt: params.endsAt,
      inclusiveEnd: params.inclusiveEnd,
    }),
  };
}

export function resolvePolicyReconcileTarget(
  policy: ReminderPolicy,
  now: Date,
): ReconcileTarget | null {
  if (policy.status !== "active") return null;
  if (policy.snoozedUntil && policy.snoozedUntil > now) return null;
  if (isRecurringIntervalPolicy(policy)) return resolveRecurringIntervalTarget(policy, now);
  if (isIntervalPolicy(policy)) return resolveIntervalTarget(policy, now);

  const configured = policy.nextFireAt;
  const currentDue = currentCanonicalOccurrenceIfDue(policy, now);
  if (
    currentDue &&
    (!configured || configured.getTime() !== currentDue.getTime()) &&
    isInsideWindow(policy, currentDue)
  ) {
    return { scheduledFor: currentDue, deliveryAt: now, catchUp: currentDue < now };
  }
  if (configured && configured > now) {
    return { scheduledFor: configured, deliveryAt: configured, catchUp: false };
  }
  if (configured && configured <= now && policy.catchUpMode !== "none") {
    return { scheduledFor: configured, deliveryAt: now, catchUp: true };
  }
  const next = nextRecurringSlot(policy, now, now);
  return next ? { scheduledFor: next, deliveryAt: next, catchUp: false } : null;
}

export function currentCanonicalOccurrenceIfDue(policy: ReminderPolicy, now: Date) {
  if (!["recurring", "long_term"].includes(policy.policyType)) return null;
  const parsed = parseCanonicalRecurrenceRule(policy.recurrenceRule);
  if (!parsed || parsed.kind === "legacy" || !parsed.timeLocal) return null;
  const timezone = policy.timezone || "Europe/Moscow";
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  const [hour, minute] = parseClock(parsed.timeLocal, 9, 0);
  const candidateLocal = nowLocal.startOf("day").set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  if (candidateLocal > nowLocal) return null;
  if (parsed.kind === "weekly") {
    const targetWeekday = WEEKDAY_NUMBERS[parsed.weekday];
    if (!targetWeekday || nowLocal.weekday !== targetWeekday) return null;
  }
  if (parsed.kind === "monthly_day_range" && !parsed.monthDays.includes(nowLocal.day)) {
    return null;
  }
  return candidateLocal.toUTC().toJSDate();
}

export function computeNextPolicySlotAfterDelivery(params: {
  policy: ReminderPolicy;
  scheduledFor: Date;
  now: Date;
}) {
  if (isRecurringIntervalPolicy(params.policy)) {
    return computeNextRecurringIntervalSlot(params.policy, params.scheduledFor, params.now);
  }

  if (isIntervalPolicy(params.policy)) {
    const intervalMinutes = params.policy.intervalMinutes ?? 30;
    return nextGridSlot({
      anchor: params.policy.startsAt ?? params.scheduledFor,
      intervalMinutes,
      after: params.now,
      endsAt: params.policy.endsAt,
      inclusiveEnd: params.policy.windowEndInclusive,
    });
  }

  if (["recurring", "long_term"].includes(params.policy.policyType)) {
    const next = nextRecurringSlot(params.policy, params.scheduledFor, params.now);
    return isInsideWindow(params.policy, next) ? next : null;
  }
  return null;
}

export function applyQuietHours(params: {
  scheduledAt: Date;
  timezone: string;
  start: string;
  end: string;
  allowDuringQuietHours?: boolean;
}) {
  if (params.allowDuringQuietHours) return params.scheduledAt;
  const local = DateTime.fromJSDate(params.scheduledAt, { zone: "utc" }).setZone(params.timezone);
  const [startHour, startMinute] = parseClock(params.start, 0, 0);
  const [endHour, endMinute] = parseClock(params.end, 7, 30);
  const start = local.startOf("day").set({ hour: startHour, minute: startMinute });
  let end = local.startOf("day").set({ hour: endHour, minute: endMinute });

  if (start < end) {
    if (local >= start && local < end) return end.toUTC().toJSDate();
    return params.scheduledAt;
  }

  if (local >= start) {
    end = end.plus({ days: 1 });
    return end.toUTC().toJSDate();
  }
  if (local < end) return end.toUTC().toJSDate();
  return params.scheduledAt;
}

function resolveIntervalTarget(policy: ReminderPolicy, now: Date): ReconcileTarget | null {
  const start = policy.startsAt ?? policy.nextFireAt;
  if (!start) return null;
  if (policy.endsAt && !isInsideWindow(policy, now) && now > policy.endsAt) return null;

  if (now < start) {
    return { scheduledFor: start, deliveryAt: start, catchUp: false };
  }

  const configured = policy.nextFireAt;
  if (
    configured &&
    configured > now &&
    isGridSlot(start, configured, policy.intervalMinutes ?? 30)
  ) {
    return { scheduledFor: configured, deliveryAt: configured, catchUp: false };
  }

  const intervalMs = (policy.intervalMinutes ?? 30) * 60 * 1000;
  const elapsed = Math.max(0, now.getTime() - start.getTime());
  const floorSteps = Math.floor(elapsed / intervalMs);
  const latest = new Date(start.getTime() + floorSteps * intervalMs);
  if (!isInsideWindow(policy, latest)) return null;

  if (policy.catchUpMode !== "none") {
    return { scheduledFor: latest, deliveryAt: now, catchUp: latest < now };
  }

  const next = latest > now ? latest : new Date(latest.getTime() + intervalMs);
  return isInsideWindow(policy, next)
    ? { scheduledFor: next, deliveryAt: next, catchUp: false }
    : null;
}

function isGridSlot(anchor: Date, candidate: Date, intervalMinutes: number) {
  const intervalMs = intervalMinutes * 60 * 1000;
  const delta = candidate.getTime() - anchor.getTime();
  return delta >= 0 && delta % intervalMs === 0;
}

function nextRecurringSlot(policy: ReminderPolicy, after: Date, now: Date) {
  let candidate = nextFromRule(policy.recurrenceRule, after, policy.timezone);
  while (candidate <= now) {
    candidate = nextFromRule(policy.recurrenceRule, candidate, policy.timezone);
  }
  return candidate;
}

function resolveRecurringIntervalTarget(
  policy: ReminderPolicy,
  now: Date,
): ReconcileTarget | null {
  const window = findRecurringIntervalWindow(policy, now);
  if (!window) return null;
  if (now < window.start) {
    return { scheduledFor: window.start, deliveryAt: window.start, catchUp: false };
  }

  const configured = policy.nextFireAt;
  if (configured && configured > now && isInsideConcreteWindow(configured, window)) {
    return { scheduledFor: configured, deliveryAt: configured, catchUp: false };
  }

  const intervalMinutes = policy.intervalMinutes ?? 30;
  const elapsed = Math.max(0, now.getTime() - window.start.getTime());
  const latest = new Date(
    window.start.getTime() + Math.floor(elapsed / (intervalMinutes * 60 * 1000)) * intervalMinutes * 60 * 1000,
  );
  if (!isInsideConcreteWindow(latest, window)) return null;
  if (policy.catchUpMode !== "none") {
    return { scheduledFor: latest, deliveryAt: now, catchUp: latest < now };
  }
  const next = nextGridSlot({
    anchor: window.start,
    intervalMinutes,
    after: now,
    endsAt: window.end,
    inclusiveEnd: policy.windowEndInclusive,
  });
  return next ? { scheduledFor: next, deliveryAt: next, catchUp: false } : null;
}

function computeNextRecurringIntervalSlot(
  policy: ReminderPolicy,
  scheduledFor: Date,
  now: Date,
) {
  const window = findRecurringIntervalWindow(policy, scheduledFor);
  const intervalMinutes = policy.intervalMinutes ?? 30;
  if (window) {
    const nextInWindow = nextGridSlot({
      anchor: window.start,
      intervalMinutes,
      after: now,
      endsAt: window.end,
      inclusiveEnd: policy.windowEndInclusive,
    });
    if (nextInWindow) return nextInWindow;
  }
  const reference = window?.end ?? scheduledFor;
  return findRecurringIntervalWindow(policy, new Date(reference.getTime() + 60_000))?.start ?? null;
}

function findRecurringIntervalWindow(policy: ReminderPolicy, reference: Date) {
  const parsed = parseCanonicalRecurrenceRule(policy.recurrenceRule);
  if (!parsed || parsed.kind === "legacy" || !parsed.timeLocal) return null;
  const timezone = policy.timezone || "Europe/Moscow";
  let cursor = DateTime.fromJSDate(reference, { zone: "utc" })
    .setZone(timezone)
    .minus({ days: 370 })
    .toUTC()
    .toJSDate();
  for (let index = 0; index < 760; index += 1) {
    const start = nextRecurringOccurrence({
      rule: policy.recurrenceRule,
      after: cursor,
      timezone,
    });
    if (!start) return null;
    const window = buildRecurringIntervalWindow(policy, start, timezone);
    if (!window.end || window.end >= reference) return window;
    cursor = new Date(start.getTime() + 60_000);
  }
  return null;
}

function buildRecurringIntervalWindow(policy: ReminderPolicy, start: Date, timezone: string) {
  const startLocal = DateTime.fromJSDate(start, { zone: "utc" }).setZone(timezone);
  const endClock =
    typeof policy.metadata?.activeWindowEnd === "string"
      ? policy.metadata.activeWindowEnd
      : null;
  if (!endClock) {
    return { start, end: null };
  }
  const [endHour, endMinute] = parseClock(endClock, 23, 59);
  let end = startLocal
    .startOf("day")
    .set({ hour: endHour, minute: endMinute, second: 0, millisecond: 0 });
  if (end <= startLocal) end = end.plus({ days: 1 });
  return { start, end: end.toUTC().toJSDate() };
}

function isInsideConcreteWindow(
  candidate: Date,
  window: { start: Date; end: Date | null },
) {
  return candidate >= window.start && (!window.end || candidate <= window.end);
}

function nextFromRule(rule: string | null, after: Date, timezone: string) {
  const canonical = nextRecurringOccurrence({ rule, after, timezone });
  if (canonical) return canonical;
  const local = DateTime.fromJSDate(after, { zone: "utc" }).setZone(timezone);
  const normalized = (rule ?? "").toLowerCase();
  if (/every[_ ]?2[_ ]?weeks|biweekly|2 weeks/.test(normalized)) {
    return local.plus({ weeks: 2 }).toUTC().toJSDate();
  }
  if (/weekly|week/.test(normalized)) return local.plus({ weeks: 1 }).toUTC().toJSDate();
  if (/monthly|month/.test(normalized)) return local.plus({ months: 1 }).toUTC().toJSDate();
  if (/yearly|annual|year/.test(normalized)) return local.plus({ years: 1 }).toUTC().toJSDate();
  if (/weekdays/.test(normalized)) {
    let candidate = local.plus({ days: 1 });
    while (candidate.weekday > 5) candidate = candidate.plus({ days: 1 });
    return candidate.toUTC().toJSDate();
  }
  return local.plus({ days: 1 }).toUTC().toJSDate();
}

function isIntervalPolicy(policy: ReminderPolicy) {
  return ["interval_window", "nag_until_ack"].includes(policy.policyType);
}

function isRecurringIntervalPolicy(policy: ReminderPolicy) {
  const parsed = parseCanonicalRecurrenceRule(policy.recurrenceRule);
  return Boolean(parsed && parsed.kind !== "legacy" && parsed.timeLocal && policy.intervalMinutes);
}

function isInsideWindow(policy: ReminderPolicy, candidate: Date) {
  if (policy.startsAt && candidate < policy.startsAt) return false;
  if (!policy.endsAt) return true;
  return policy.windowEndInclusive !== false
    ? candidate <= policy.endsAt
    : candidate < policy.endsAt;
}

function parseClock(value: string, fallbackHour: number, fallbackMinute: number) {
  const [hour, minute] = value.split(":").map(Number);
  return [
    Number.isFinite(hour) ? hour : fallbackHour,
    Number.isFinite(minute) ? minute : fallbackMinute,
  ] as const;
}
