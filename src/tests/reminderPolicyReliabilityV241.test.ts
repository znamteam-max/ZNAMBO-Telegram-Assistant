import { describe, expect, it } from "vitest";

import {
  applyQuietHours,
  computeNextPolicySlotAfterDelivery,
  resolvePolicyReconcileTarget,
} from "@/domain/reminderPolicySchedule";
import type { ReminderPolicy } from "@/db/schema";

describe("V2.4.1 reminder policy schedule reliability", () => {
  it("advances from occurrence scheduled time without interval drift", () => {
    const policy = makePolicy();
    const next = computeNextPolicySlotAfterDelivery({
      policy,
      scheduledFor: new Date("2026-06-08T06:00:00.000Z"),
      now: new Date("2026-06-08T06:04:00.000Z"),
    });

    expect(next).toEqual(new Date("2026-06-08T06:30:00.000Z"));
  });

  it("creates one immediate catch-up and resumes on the next grid slot", () => {
    const policy = makePolicy({
      nextFireAt: new Date("2026-06-08T05:00:00.000Z"),
    });
    const now = new Date("2026-06-08T06:12:00.000Z");
    const target = resolvePolicyReconcileTarget(policy, now);

    expect(target).toEqual({
      scheduledFor: new Date("2026-06-08T06:00:00.000Z"),
      deliveryAt: now,
      catchUp: true,
    });
    expect(
      computeNextPolicySlotAfterDelivery({
        policy,
        scheduledFor: target!.scheduledFor,
        now,
      }),
    ).toEqual(new Date("2026-06-08T06:30:00.000Z"));
  });

  it("defers a quiet-hours reminder to the configured quiet-hours end", () => {
    expect(
      applyQuietHours({
        scheduledAt: new Date("2026-06-08T01:00:00.000Z"),
        timezone: "Europe/Moscow",
        start: "00:00",
        end: "07:30",
      }),
    ).toEqual(new Date("2026-06-08T04:30:00.000Z"));
  });
});

function makePolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: "policy-id",
    userId: "user-id",
    itemId: "item-id",
    title: "Позвонить Дрик",
    category: "people",
    policyType: "interval_window",
    status: "active",
    timezone: "Europe/Moscow",
    startsAt: new Date("2026-06-08T05:00:00.000Z"),
    endsAt: new Date("2026-06-08T11:00:00.000Z"),
    nextFireAt: new Date("2026-06-08T06:00:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: 30,
    requireAck: true,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    quietHours: null,
    escalationPolicy: null,
    metadata: { stopOnItemComplete: true },
    createdAt: new Date("2026-06-08T05:00:00.000Z"),
    updatedAt: new Date("2026-06-08T05:00:00.000Z"),
    ...overrides,
  };
}
