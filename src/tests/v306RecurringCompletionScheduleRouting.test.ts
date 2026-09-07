import { describe, expect, it } from "vitest";

import {
  buildRecurringScheduleRule,
  nextRecurringScheduleOccurrence,
  parseRecurringScheduleCallbackData,
  parseRecurringScheduleFollowup,
} from "@/domain/recurringScheduleEdit";
import { isPersistentRecurringPolicy } from "@/services/recurringOccurrenceCompletion";

describe("V3.0.6 persistent recurring completion and schedule target lock", () => {
  const itemId = "e0cd618f-7a0b-4990-bd9e-d5450a228a4d";

  it("splits the exact failing daily callback into item id and preset", () => {
    expect(parseRecurringScheduleCallbackData(`policy_schedule:${itemId}:daily`)).toEqual({
      itemId,
      preset: "daily",
    });
  });

  it("never treats the schedule suffix as part of a planner item id", () => {
    const parsed = parseRecurringScheduleCallbackData(`policy_schedule:${itemId}:daily`);
    expect(parsed?.itemId).toBe(itemId);
    expect(parsed?.itemId).not.toContain(":daily");
  });

  it("parses the exact user follow-up as 08:00 plus a four-hour cadence", () => {
    expect(parseRecurringScheduleFollowup("Каждый день в 8.00, повторять каждые 4 часа")).toEqual({
      timeLocal: "08:00",
      intervalMinutes: 240,
    });
  });

  it("does not mistake cadence-only four hours for a clock time", () => {
    expect(parseRecurringScheduleFollowup("повторять каждые 4 часа")).toEqual({
      timeLocal: null,
      intervalMinutes: 240,
    });
  });

  it("builds a daily target-locked recurrence and advances past today's elapsed 08:00", () => {
    const now = new Date("2026-09-07T05:31:00.000Z");
    const rule = buildRecurringScheduleRule({
      preset: "daily",
      timeLocal: "08:00",
      now,
      timezone: "Europe/Moscow",
    });
    expect(rule).toBe("daily@08:00");
    expect(
      nextRecurringScheduleOccurrence({
        rule,
        preset: "daily",
        timeLocal: "08:00",
        after: now,
        timezone: "Europe/Moscow",
      })?.toISOString(),
    ).toBe("2026-09-08T05:00:00.000Z");
  });

  it("treats recurring and long-term policies as persistent parents", () => {
    expect(isPersistentRecurringPolicy({ policyType: "recurring" })).toBe(true);
    expect(isPersistentRecurringPolicy({ policyType: "long_term" })).toBe(true);
    expect(isPersistentRecurringPolicy({ policyType: "one_time" })).toBe(false);
  });
});
