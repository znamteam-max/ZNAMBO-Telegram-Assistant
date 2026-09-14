import { describe, expect, it } from "vitest";

import { parseStandaloneIntervalWindowReminderIntent } from "@/domain/intervalWindowReminderIntent";
import { parseScheduledCreationIntent } from "@/domain/scheduledCreationIntent";
import { normalizeUntilDoneReminder } from "@/domain/untilDoneReminderText";

describe("V3.0.7 Sep 14 reminder routing regressions", () => {
  it("creates today's hourly-until-17 reminder deterministically without an explicit start", () => {
    const intent = parseStandaloneIntervalWindowReminderIntent({
      text: "Сегодня каждый час до 17.00 напоминай мне про интервью с Андреем Рублёвым",
      timezone: "Europe/Moscow",
      now: new Date("2026-09-14T05:42:29.304Z"),
    });

    expect(intent).not.toBeNull();
    expect(intent?.title).toBe("Интервью с Андреем Рублёвым");
    expect(intent?.intervalMinutes).toBe(60);
    expect(intent?.windowStartLocal).toBe("08:43");
    expect(intent?.windowEndLocal).toBe("17:00");
    expect(intent?.startsAtLocalIso).toBe("2026-09-14T08:43:00");
    expect(intent?.endsAtLocalIso).toBe("2026-09-14T17:00:00");
  });

  it("does not silently add an end-of-day boundary to until-done", () => {
    const normalized = normalizeUntilDoneReminder({
      text: "Каждые 4 часа, пока не отмечу",
      timezone: "Europe/Moscow",
      now: new Date("2026-09-13T12:19:39.052Z"),
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.intervalMinutes).toBe(240);
    expect(normalized?.endOfDayExplicit).toBe(false);
    expect(normalized?.windowEnd).toBeNull();
    expect(normalized?.endsAt).toBeNull();
  });

  it("keeps end-of-day finite only when the user explicitly asks for it", () => {
    const normalized = normalizeUntilDoneReminder({
      text: "Каждые 4 часа до конца дня, пока не отмечу",
      timezone: "Europe/Moscow",
      now: new Date("2026-09-13T12:19:39.052Z"),
    });

    expect(normalized?.endOfDayExplicit).toBe(true);
    expect(normalized?.windowEnd).toBe("23:59");
    expect(normalized?.endsAt).not.toBeNull();
  });

  it("keeps 07:00 when reminder text later contains the word 'дня'", () => {
    const intent = parseScheduledCreationIntent({
      text: "Взял Мяч NEWS в пятницу в 7.00, напомни за два дня и за день до в 12.00",
      timezone: "Europe/Moscow",
      now: new Date("2026-09-07T10:47:00.000Z"),
    });

    expect(intent).not.toBeNull();
    expect(intent?.startLocal).toBe("2026-09-11T07:00:00");
    expect(intent?.reminders.map((entry) => entry.fireAtLocal)).toEqual([
      "2026-09-09T12:00:00",
      "2026-09-10T12:00:00",
    ]);
    expect(intent?.reminders.map((entry) => entry.label)).toEqual([
      "за 2 дня в 12:00",
      "за день в 12:00",
    ]);
  });

  it("does not leave a dangling preposition before a scheduled event noun", () => {
    const intent = parseScheduledCreationIntent({
      text: "Завтра в 12.00 созвон с Олей из Винлайн по Рус. Баскету",
      timezone: "Europe/Moscow",
      now: new Date("2026-09-13T12:18:52.618Z"),
    });

    expect(intent).not.toBeNull();
    expect(intent?.title).toBe("Созвон с Олей из Винлайн по Рус. Баскету");
    expect(intent?.startLocal).toBe("2026-09-14T12:00:00");
  });
});
