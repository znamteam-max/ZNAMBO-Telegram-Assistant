import { describe, expect, it } from "vitest";

import { chooseSpacedReminderSlot } from "@/services/reminderCollisionSpacing";

describe("V3.0.1 stability: exact relative reminder time", () => {
  it("does not shift a user-relative +120 minute target with sub-minute precision", () => {
    const desiredAt = new Date("2026-09-03T08:29:12.757Z");
    const result = chooseSpacedReminderSlot({
      desiredAt,
      occupiedSlots: [new Date("2026-09-03T08:30:00.000Z")],
    });

    expect(result.scheduledAt.toISOString()).toBe("2026-09-03T08:29:12.757Z");
    expect(result.shifted).toBe(false);
    expect(result.shiftMinutes).toBe(0);
  });

  it("still spaces canonical minute-aligned automatic reminder slots", () => {
    const desiredAt = new Date("2026-09-03T08:30:00.000Z");
    const result = chooseSpacedReminderSlot({
      desiredAt,
      occupiedSlots: [new Date("2026-09-03T08:30:00.000Z")],
    });

    expect(result.scheduledAt.toISOString()).toBe("2026-09-03T08:35:00.000Z");
    expect(result.shifted).toBe(true);
    expect(result.shiftMinutes).toBe(5);
  });
});
