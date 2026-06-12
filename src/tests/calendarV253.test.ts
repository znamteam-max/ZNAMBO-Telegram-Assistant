import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvCacheForTests } from "@/lib/env";
import {
  classifyYandexCalendarError,
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

    expect(result).toEqual({
      ok: true,
      errorClass: null,
      steps: { authorization: "ok", create: "ok", read: "ok", delete: "ok" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
