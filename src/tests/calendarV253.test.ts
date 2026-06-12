import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvCacheForTests } from "@/lib/env";
import {
  buildCalendarObjectUrl,
  classifyYandexCalendarError,
  getYandexCalendarConfigDebug,
  runYandexCalendarTest,
} from "@/integrations/yandexCalendar";
import { formatCalendarSyncFeedback } from "@/services/calendarBestEffort";

describe("V2.5.3 Yandex calendar verification", () => {
  beforeEach(() => {
    process.env.YANDEX_CALDAV_USERNAME = "calendar-user";
    process.env.YANDEX_CALDAV_APP_PASSWORD = "calendar-password";
    process.env.YANDEX_CALDAV_CALENDAR_URL = "https://caldav.example.test/calendar/";
    resetEnvCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.YANDEX_CALDAV_USERNAME;
    delete process.env.YANDEX_CALDAV_APP_PASSWORD;
    delete process.env.YANDEX_CALDAV_CALENDAR_URL;
    resetEnvCacheForTests();
  });

  it("creates, reads back and deletes a temporary CalDAV event", async () => {
    let body = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PROPFIND") return new Response("", { status: 207 });
      if (init?.method === "PUT") {
        body = String(init.body);
        return new Response("", { status: 201 });
      }
      if (init?.method === "GET") return new Response(body, { status: 200 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runYandexCalendarTest();

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      errorClass: null,
      calendarObjectUrl: expect.stringMatching(/\.ics$/),
      diagnostics: {
        calendarUrlSource: "YANDEX_CALDAV_CALENDAR_URL",
        collectionUrlNormalized: true,
        createdObjectUrlPresent: true,
      },
      steps: { authorization: "ok", create: "ok", read: "ok", delete: "ok" },
    }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const objectCalls = fetchMock.mock.calls.filter(([, init]) =>
      ["PUT", "GET", "DELETE"].includes(String(init?.method)),
    );
    expect(new Set(objectCalls.map(([url]) => url))).toEqual(
      new Set([result.calendarObjectUrl]),
    );
    expect(objectCalls.every(([, init]) => init?.redirect === "manual")).toBe(true);
    const testUid = body.match(/UID:([0-9a-f-]+)@znambo-telegram-assistant/)?.[1];
    expect(testUid).toBeTruthy();
    expect(result.calendarObjectUrl).toMatch(new RegExp(`/${testUid}\\.ics$`));
  });

  it("normalizes configured collection URLs with and without a trailing slash", () => {
    expect(buildCalendarObjectUrl("https://caldav.example.test/calendar/", "uid-1")).toBe(
      "https://caldav.example.test/calendar/uid-1.ics",
    );
    expect(buildCalendarObjectUrl("https://caldav.example.test/calendar", "uid-1")).toBe(
      "https://caldav.example.test/calendar/uid-1.ics",
    );
  });

  it("reports calendar object URL construction failures safely", () => {
    expect(() => buildCalendarObjectUrl("not-a-url", "uid-1")).toThrow(
      "Calendar object URL could not be built.",
    );
    expect(
      classifyYandexCalendarError(
        (() => {
          try {
            buildCalendarObjectUrl("not-a-url", "uid-1");
          } catch (error) {
            return error;
          }
        })(),
      ).errorClass,
    ).toBe("calendar_object_url_build_failed");
  });

  it("does not rely on a Location header and retries a transient read-back 404", async () => {
    let body = "";
    let reads = 0;
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = String(init?.method);
      calls.push({ url, method });
      if (method === "PROPFIND") return new Response("", { status: 207 });
      if (method === "PUT") {
        body = String(init?.body);
        return new Response("", { status: 201 });
      }
      if (method === "GET") {
        reads += 1;
        return reads === 1
          ? new Response("", { status: 404 })
          : new Response(body, { status: 200 });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response("", { status: 500 });
    }));

    const result = await runYandexCalendarTest();

    expect(result.ok).toBe(true);
    expect(reads).toBe(2);
    expect(new Set(calls.filter((call) => call.method !== "PROPFIND").map((call) => call.url))).toEqual(
      new Set([result.calendarObjectUrl]),
    );
  });

  it("reports read-back 404 separately and still cleans up the created object", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PROPFIND") return new Response("", { status: 207 });
      if (init?.method === "PUT") return new Response("", { status: 201 });
      if (init?.method === "GET") return new Response("", { status: 404 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response("", { status: 500 });
    }));

    const result = await runYandexCalendarTest();

    expect(result.errorClass).toBe("read_back_not_found");
    expect(result.steps).toEqual({
      authorization: "ok",
      create: "ok",
      read: "failed",
      delete: "ok",
    });
  });

  it("returns safe URL diagnostics without credential values", () => {
    const debug = getYandexCalendarConfigDebug();
    const serialized = JSON.stringify(debug);
    expect(debug).toEqual(expect.objectContaining({
      hasCalendarUrl: true,
      calendarUrlSource: "YANDEX_CALDAV_CALENDAR_URL",
      collectionUrlNormalized: true,
      createdObjectUrlPresent: false,
    }));
    expect(serialized).not.toContain("calendar-user");
    expect(serialized).not.toContain("calendar-password");
    expect(serialized).not.toContain("caldav.example.test/calendar");
  });

  it("returns a safe auth_failed class without leaking a response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<secret>raw xml</secret>", { status: 401 })));
    const result = await runYandexCalendarTest();
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("auth_failed");
    expect(JSON.stringify(result)).not.toContain("raw xml");
    expect(classifyYandexCalendarError(new Error("socket failed")).errorClass).toBe("network_error");
  });

  it("formats visible non-blocking sync feedback", () => {
    const text = formatCalendarSyncFeedback([
      { itemId: "1", title: "Встреча", status: "failed", provider: "yandex", errorClass: "auth_failed" },
    ]);
    expect(text).toContain("записи в JARVIS сохранены");
    expect(text).toContain("auth_failed");
  });
});
