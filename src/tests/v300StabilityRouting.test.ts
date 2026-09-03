import { describe, expect, it } from "vitest";

import {
  looksLikeExplicitNewScheduledCreationText,
  parseScheduledCreationIntent,
} from "@/domain/scheduledCreationIntent";

describe("V3.0 stability routing regressions", () => {
  const timezone = "Europe/Moscow";
  const now = new Date("2026-09-03T05:00:00.000Z");

  it("treats an explicit standalone meeting with a clock time as a new event", () => {
    const intent = parseScheduledCreationIntent({
      text: "Созвон по Взял Мчч в 18.00",
      timezone,
      now,
    });

    expect(intent).not.toBeNull();
    expect(intent?.kind).toBe("event");
    expect(intent?.title).toBe("Созвон по Взял Мчч");
    expect(intent?.startLocal).toBe("2026-09-03T18:00:00");
    expect(intent?.endLocal).toBe("2026-09-03T19:00:00");
    expect(intent?.reminders).toEqual([]);
    expect(intent?.remindersSuppressedByUser).toBe(false);
    expect(looksLikeExplicitNewScheduledCreationText("Созвон по Взял Мчч в 18.00")).toBe(true);
  });

  it("does not treat a bare time reply as a new event", () => {
    expect(
      parseScheduledCreationIntent({
        text: "18.00",
        timezone,
        now,
      }),
    ).toBeNull();
    expect(looksLikeExplicitNewScheduledCreationText("18.00")).toBe(false);
  });

  it("leaves explicit event reschedule commands to management routing", () => {
    expect(
      parseScheduledCreationIntent({
        text: "Перенеси созвон на завтра в 18.00",
        timezone,
        now,
      }),
    ).toBeNull();
    expect(looksLikeExplicitNewScheduledCreationText("Перенеси созвон на завтра в 18.00")).toBe(false);
  });

  it("keeps reminder-driven event creation working", () => {
    const intent = parseScheduledCreationIntent({
      text: "Созвон с Дашей завтра в 14:00, напомни за 30 минут",
      timezone,
      now,
    });

    expect(intent).not.toBeNull();
    expect(intent?.startLocal).toBe("2026-09-04T14:00:00");
    expect(intent?.reminders).toHaveLength(1);
  });
});
