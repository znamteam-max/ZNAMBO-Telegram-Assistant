import { DateTime } from "luxon";

import type { ReminderPolicy } from "@/db/schema";

export type ReconcileTarget = {
  scheduledFor: Date;
  deliveryAt: Date;
  catchUp: boolean;
};

export function resolvePolicyReconcileTarget(
  policy: ReminderPolicy,
  now: Date,
): ReconcileTarget | null {
  if (policy.status !== "active") return null;
  if (isIntervalPolicy(policy)) return resolveIntervalTarget(policy, now);

  const configured = policy.nextFireAt;
  if (configured && configured > now) {
    return { scheduledFor: configured, deliveryAt: configured, catchUp: false };
  }
  if (configured && configured <= now && policy.catchUpMode !== "none") {
    return { scheduledFor: configured, deliveryAt: now, catchUp: true };
  }
  const next = nextRecurringSlot(policy, now, now);
  return next ? { scheduledFor: next, deliveryAt: next, catchUp: false } : null;
}

export function computeNextPolicySlotAfterDelivery(params: {
  policy: ReminderPolicy;
  scheduledFor: Date;
  now: Date;
}) {
  if (isIntervalPolicy(params.policy)) {
    const intervalMinutes = params.policy.intervalMinutes ?? 30;
    let candidate = DateTime.fromJSDate(params.scheduledFor, { zone: "utc" })
      .plus({ minutes: intervalMinutes })
      .toJSDate();
    while (candidate <= params.now) {
      candidate = DateTime.fromJSDate(candidate, { zone: "utc" })
        .plus({ minutes: intervalMinutes })
        .toJSDate();
    }
    return isInsideWindow(params.policy, candidate) ? candidate : null;
  }

  if (["recurring", "long_term"].includes(params.policy.policyType)) {
    return nextRecurringSlot(params.policy, params.scheduledFor, params.now);
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
  if (configured && configured > now) {
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

function nextRecurringSlot(policy: ReminderPolicy, after: Date, now: Date) {
  let candidate = nextFromRule(policy.recurrenceRule, after, policy.timezone);
  while (candidate <= now) {
    candidate = nextFromRule(policy.recurrenceRule, candidate, policy.timezone);
  }
  return candidate;
}

function nextFromRule(rule: string | null, after: Date, timezone: string) {
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

function isInsideWindow(policy: ReminderPolicy, candidate: Date) {
  if (policy.startsAt && candidate < policy.startsAt) return false;
  if (!policy.endsAt) return true;
  return policy.windowEndInclusive !== false ? candidate <= policy.endsAt : candidate < policy.endsAt;
}

function parseClock(value: string, fallbackHour: number, fallbackMinute: number) {
  const [hour, minute] = value.split(":").map(Number);
  return [
    Number.isFinite(hour) ? hour : fallbackHour,
    Number.isFinite(minute) ? minute : fallbackMinute,
  ] as const;
}
