import { describe, expect, it } from "vitest";

import {
  buildRecurringScheduleRule,
  inferRecurringSchedulePresetFromText,
  nextRecurringScheduleOccurrence,
  parseRecurringScheduleCallbackData,
  parseRecurringScheduleFollowup,
  resolveRecurringScheduleTiming,
} from "@/domain/recurringScheduleEdit";
import {
  isPersistentRecurringParent,
  isPersistentRecurringPolicy,
} from "@/services/recurringOccurrenceCompletion";

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

  it("parses the original preset follow-up as 08:00 plus a four-hour cadence", () => {
    expect(parseRecurringScheduleFollowup("Каждый день в 8.00, повторять каждые 4 часа")).toEqual({
      timeLocal: "08:00",
      intervalMinutes: 240,
    });
  });

  it("parses the exact Sep 7 custom-rule wording with 'с 8.00' without AI", () => {
    const text = "Каждый день с 8.00 каждые 4 часа, пока не отмечу или не перенесу на следующий день";
    expect(inferRecurringSchedulePresetFromText(text)).toBe("daily");
    expect(parseRecurringScheduleFollowup(text)).toEqual({
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

  it("keeps the four-hour grid inside today and chooses 12:00 after a 09:39 setup", () => {
    const now = new Date("2026-09-07T06:39:17.000Z");
    const rule = buildRecurringScheduleRule({
      preset: "daily",
      timeLocal: "08:00",
      now,
      timezone: "Europe/Moscow",
    });
    const timing = resolveRecurringScheduleTiming({
      rule,
      preset: "daily",
      timeLocal: "08:00",
      intervalMinutes: 240,
      after: now,
      timezone: "Europe/Moscow",
    });
    expect(timing?.startsAt.toISOString()).toBe("2026-09-07T05:00:00.000Z");
    expect(timing?.nextFireAt.toISOString()).toBe("2026-09-07T09:00:00.000Z");
  });

  it("distinguishes a persistent recurring parent from recurring reminders on a one-off task", () => {
    expect(isPersistentRecurringPolicy({ policyType: "recurring" })).toBe(true);
    expect(isPersistentRecurringPolicy({ policyType: "long_term" })).toBe(true);
    expect(isPersistentRecurringPolicy({ policyType: "one_time" })).toBe(false);

    expect(
      isPersistentRecurringParent({
        itemKind: "task",
        policy: {
          policyType: "recurring",
          metadata: { recurringParentPersistent: false, stopOnItemComplete: true },
        },
      }),
    ).toBe(false);
    expect(
      isPersistentRecurringParent({
        itemKind: "recurring_task",
        policy: {
          policyType: "recurring",
          metadata: { recurringParentPersistent: true, stopOnItemComplete: false },
        },
      }),
    ).toBe(true);
  });
});
