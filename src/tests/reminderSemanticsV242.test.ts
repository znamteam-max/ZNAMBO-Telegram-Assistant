import { describe, expect, it } from "vitest";

import { nextGridSlot, planPolicySnooze } from "@/domain/reminderPolicySchedule";

describe("V2.4.2 transactional reminder semantics", () => {
  it("keeps the policy grid anchored after a 30-minute snooze at 10:14", () => {
    const plan = planPolicySnooze({
      anchor: new Date("2026-06-09T05:00:00.000Z"),
      intervalMinutes: 30,
      now: new Date("2026-06-09T07:14:00.000Z"),
      snoozeMinutes: 30,
      endsAt: new Date("2026-06-09T11:00:00.000Z"),
      inclusiveEnd: true,
    });

    expect(plan).toEqual({
      snoozeAt: new Date("2026-06-09T07:44:00.000Z"),
      nextRegularAt: new Date("2026-06-09T08:00:00.000Z"),
    });
    expect(
      nextGridSlot({
        anchor: new Date("2026-06-09T05:00:00.000Z"),
        intervalMinutes: 30,
        after: plan.nextRegularAt!,
        endsAt: new Date("2026-06-09T11:00:00.000Z"),
        inclusiveEnd: true,
      }),
    ).toEqual(new Date("2026-06-09T08:30:00.000Z"));
  });

  it("allows one final 14:00 grid slot and none after the window", () => {
    const anchor = new Date("2026-06-09T05:00:00.000Z");
    const end = new Date("2026-06-09T11:00:00.000Z");

    expect(
      nextGridSlot({
        anchor,
        intervalMinutes: 30,
        after: new Date("2026-06-09T10:30:00.000Z"),
        endsAt: end,
        inclusiveEnd: true,
      }),
    ).toEqual(end);
    expect(
      nextGridSlot({
        anchor,
        intervalMinutes: 30,
        after: end,
        endsAt: end,
        inclusiveEnd: true,
      }),
    ).toBeNull();
    expect(
      planPolicySnooze({
        anchor,
        intervalMinutes: 30,
        now: new Date("2026-06-09T10:44:00.000Z"),
        snoozeMinutes: 30,
        endsAt: end,
        inclusiveEnd: true,
      }),
    ).toEqual({ snoozeAt: null, nextRegularAt: null });
  });
});
