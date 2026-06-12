import { afterEach, describe, expect, it, vi } from "vitest";

import {
  entityListKeyboard,
  externalCalendarDeleteKeyboard,
  itemMenuKeyboard,
  itemMoreKeyboard,
  navigationKeyboard,
} from "@/bot/keyboards";
import type { PlannerItem } from "@/db/schema";
import {
  parseCalendarQueryResponse,
  updateYandexCalendarObject,
} from "@/integrations/yandexCalendar";
import { resetEnvCacheForTests } from "@/lib/env";
import { parseItemEditMutation } from "@/services/itemEditMutations";
import { parseRussianDateTime, parseRussianTimeRange } from "@/services/russianDateTime";
import { formatDashboardItem } from "@/telegram/liveDashboard";

const now = new Date("2026-06-12T15:06:00.000Z");

describe("V2.6.0 Plan UI and editing", () => {
  it("keeps Plan rows clean and only shows manually selected importance", () => {
    expect(formatDashboardItem(item(), "Europe/Moscow")).not.toContain("🔴");
    expect(formatDashboardItem(item(), "Europe/Moscow")).not.toContain("🟢");
    expect(
      formatDashboardItem(
        item({ priority: 4, metadata: { importanceMode: "manual" } }),
        "Europe/Moscow",
      ),
    ).toContain("⭐");
    expect(
      formatDashboardItem(item({ priority: 5, metadata: { importanceMode: "auto" } }), "Europe/Moscow"),
    ).not.toContain("🔥");
  });

  it("keeps technical actions under More and retry only on failed cards", () => {
    const normal = itemMenuKeyboard("item", null, "synced").inline_keyboard.flat().map((b) => b.text);
    const failed = itemMenuKeyboard("item", null, "pending_retry").inline_keyboard.flat().map((b) => b.text);
    const more = itemMoreKeyboard("item").inline_keyboard.flat().map((b) => b.text);

    expect(normal).not.toContain("Safe debug");
    expect(normal).not.toContain("Повторить sync");
    expect(failed).toContain("Повторить sync");
    expect(more).toContain("Safe debug");
    expect(more).toContain("История / Итоги");
  });

  it("provides persistent bottom navigation", () => {
    expect(navigationKeyboard().keyboard.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["🏠 План", "➕ Добавить", "✅ Задачи", "🔔 Напоминания", "⚙️ Настройки"]),
    );
  });

  it("keeps external event callback data within Telegram's 64-byte limit", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const callbacks = [
      ...entityListKeyboard([{ type: "external_calendar_event", id }]).inline_keyboard.flat(),
      ...externalCalendarDeleteKeyboard(id).inline_keyboard.flat(),
    ]
      .map((button) => button.callback_data)
      .filter((value): value is string => Boolean(value));
    expect(callbacks.length).toBeGreaterThan(0);
    expect(Math.max(...callbacks.map((value) => Buffer.byteLength(value, "utf8")))).toBeLessThanOrEqual(64);
  });

  it("interprets a bare same-day evening hour in the future", () => {
    const parsed = parseRussianDateTime({
      text: "сегодня в 8",
      timezone: "Europe/Moscow",
      now,
    });
    expect(parsed?.local.toFormat("yyyy-LL-dd HH:mm")).toBe("2026-06-12 20:00");
    expect(parsed?.warnings).toContain("ambiguous_hour_assumed_pm");
    expect(parsed?.pastConfirmationRequired).toBe(false);
  });

  it.each([
    ["с 18.15 до 19.00", "2026-06-13 18:15", "2026-06-13 19:00"],
    ["19:00–20:00", "2026-06-13 19:00", "2026-06-13 20:00"],
  ])("preserves range %s on the edited item's date", (text, start, end) => {
    const parsed = parseRussianTimeRange({
      text,
      timezone: "Europe/Moscow",
      now,
      baseDate: new Date("2026-06-13T07:00:00.000Z"),
    });
    expect(parsed?.startLocal.toFormat("yyyy-LL-dd HH:mm")).toBe(start);
    expect(parsed?.endLocal.toFormat("yyyy-LL-dd HH:mm")).toBe(end);
  });

  it("renames without quotes and applies the explicit end time", () => {
    const mutation = parseItemEditMutation({
      text: "Изменить на Общий созвон по ЧМ + СММ, время с 19.00 до 20.00",
      item: item({ title: "Старый созвон" }),
      timezone: "Europe/Moscow",
      now,
    });
    expect(mutation.title).toBe("Общий созвон по ЧМ + СММ");
    expect(mutation.scheduledForLocal).toContain("19:00:00");
    expect(mutation.endsAtLocal).toContain("20:00:00");
  });
});

describe("V2.6.0 Yandex inbound calendar parsing", () => {
  afterEach(() => {
    delete process.env.YANDEX_CALDAV_URL;
    delete process.env.YANDEX_CALDAV_USERNAME;
    delete process.env.YANDEX_CALDAV_APP_PASSWORD;
    vi.unstubAllGlobals();
    resetEnvCacheForTests();
  });

  it("parses a single event and expands a weekly event in the requested window", () => {
    process.env.YANDEX_CALDAV_URL = "https://caldav.example.test/";
    resetEnvCacheForTests();
    const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendars/me/personal/team.ics</D:href>
    <D:propstat><D:prop><D:getetag>"etag-1"</D:getetag><C:calendar-data><![CDATA[
BEGIN:VCALENDAR
BEGIN:VEVENT
UID:weekly-team
DTSTART;TZID=Europe/Moscow:20260615T120000
DTEND;TZID=Europe/Moscow:20260615T130000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3
SUMMARY:Weekly team sync
END:VEVENT
END:VCALENDAR
]]></C:calendar-data></D:prop></D:propstat>
  </D:response>
</D:multistatus>`;
    const events = parseCalendarQueryResponse({
      xml,
      from: new Date("2026-06-12T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
      timezone: "Europe/Moscow",
    });

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual(
      expect.objectContaining({
        uid: "weekly-team",
        summary: "Weekly team sync",
        isRecurring: true,
        calendarObjectUrl: "https://caldav.example.test/calendars/me/personal/team.ics",
      }),
    );
    expect(new Set(events.map((event) => event.recurrenceId)).size).toBe(3);
  });

  it("updates a non-recurring external event at the same object URL", async () => {
    process.env.YANDEX_CALDAV_USERNAME = "calendar-user";
    process.env.YANDEX_CALDAV_APP_PASSWORD = "calendar-password";
    resetEnvCacheForTests();
    const objectUrl = "https://caldav.example.test/calendar/external.ics";
    const calls: Array<{ url: string; method: string; ifMatch?: string }> = [];
    let body = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: String(init?.method),
        ifMatch: (init?.headers as Record<string, string> | undefined)?.["if-match"],
      });
      if (init?.method === "PUT") {
        body = String(init.body);
        return new Response(null, { status: 204 });
      }
      return new Response(body, { status: 200 });
    }));

    await updateYandexCalendarObject({
      calendarObjectUrl: objectUrl,
      uid: "external-event",
      etag: "\"etag-1\"",
      summary: "Updated event",
      startAt: new Date("2026-06-15T09:00:00.000Z"),
      endAt: new Date("2026-06-15T10:00:00.000Z"),
    });

    expect(calls.map((call) => call.url)).toEqual([objectUrl, objectUrl]);
    expect(calls.map((call) => call.method)).toEqual(["PUT", "GET"]);
    expect(calls[0].ifMatch).toBe("\"etag-1\"");
  });
});

function item(overrides: Partial<PlannerItem> = {}): PlannerItem {
  const createdAt = new Date("2026-06-01T00:00:00.000Z");
  return {
    id: "item-id",
    userId: "user-id",
    pendingActionId: null,
    kind: "event",
    status: "active",
    title: "Созвон",
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: new Date("2026-06-13T16:00:00.000Z"),
    endAt: new Date("2026-06-13T17:00:00.000Z"),
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: null,
    visibility: "active",
    sourcePolicyId: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}
