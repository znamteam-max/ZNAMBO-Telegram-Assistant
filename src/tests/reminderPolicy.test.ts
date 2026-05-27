import { describe, expect, it } from "vitest";

import { buildPresetReminders } from "@/domain/reminderPolicy";
import type { MaterializedItem } from "@/domain/types";

describe("reminder policy", () => {
  it("does not create reminders in the past", () => {
    const now = new Date("2026-05-28T09:30:00.000Z");
    const item: MaterializedItem = {
      kind: "event",
      title: "Встреча",
      timezone: "Europe/Helsinki",
      startAt: new Date("2026-05-28T10:00:00.000Z"),
      endAt: new Date("2026-05-28T11:00:00.000Z"),
      dueAt: null,
      priority: 3,
      metadata: {},
    };

    const reminders = buildPresetReminders(item, now, ["24h", "day_morning", "1h", "followup"]);
    expect(reminders.map((reminder) => reminder.type)).toEqual(["followup"]);
  });
});
