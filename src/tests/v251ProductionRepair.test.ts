import { describe, expect, it } from "vitest";

import type { ReminderPolicy } from "@/db/schema";
import { findDuplicateCentralPolicyIds } from "@/services/v251ProductionRepair";

describe("V2.5.1 production repair", () => {
  it("expires duplicate Central Park schedules without merging different events", () => {
    const firstMorning = policy({
      id: "first-morning",
      itemId: "first-event",
      recurrenceRule: "daily_at_10:00",
    });
    const firstMorningDuplicate = policy({
      id: "first-morning-duplicate",
      itemId: "first-event",
      recurrenceRule: "daily_at_10:00",
      createdAt: new Date("2026-06-10T10:00:00.000Z"),
    });
    const secondMorning = policy({
      id: "second-morning",
      itemId: "second-event",
      recurrenceRule: "daily_at_10:00",
    });

    expect(
      findDuplicateCentralPolicyIds([firstMorningDuplicate, secondMorning, firstMorning]),
    ).toEqual(["first-morning-duplicate"]);
  });
});

function policy(overrides: Partial<ReminderPolicy>): ReminderPolicy {
  return {
    id: "policy",
    userId: "user",
    itemId: "item",
    title: "Студия Central Park",
    category: "meeting",
    policyType: "recurring",
    status: "active",
    timezone: "Europe/Moscow",
    startsAt: new Date("2026-06-10T07:00:00.000Z"),
    endsAt: new Date("2026-06-11T15:00:00.000Z"),
    nextFireAt: new Date("2026-06-10T15:00:00.000Z"),
    recurrenceRule: "daily_at_18:00",
    intervalMinutes: null,
    requireAck: false,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "latest_only",
    onWindowEnd: "expire_silently",
    quietHours: null,
    escalationPolicy: null,
    metadata: {},
    createdAt: new Date("2026-06-10T09:00:00.000Z"),
    updatedAt: new Date("2026-06-10T09:00:00.000Z"),
    ...overrides,
  };
}
