import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlannerItem } from "@/db/schema";
import { resetEnvCacheForTests } from "@/lib/env";

const mocks = vi.hoisted(() => ({
  getItemCalendarSyncState: vi.fn(),
  markGoogleCalendarSync: vi.fn(),
}));

vi.mock("@/db/queries/googleCalendar", () => ({
  getItemCalendarSyncState: mocks.getItemCalendarSyncState,
  markGoogleCalendarSync: mocks.markGoogleCalendarSync,
}));

import { syncPlannerItemToYandex } from "@/integrations/yandexCalendar";

const item = {
  id: "11111111-2222-3333-4444-555555555555",
  userId: "user-id",
  kind: "event",
  status: "active",
  title: "Отвести Роба к ортодонту",
  description: null,
  location: null,
  timezone: "Europe/Moscow",
  startAt: new Date("2026-06-16T07:20:00.000Z"),
  endAt: new Date("2026-06-16T08:20:00.000Z"),
} as PlannerItem;

describe("V2.5.3.1 normal CalDAV sync resilience", () => {
  beforeEach(() => {
    process.env.CALENDAR_PROVIDER = "yandex";
    process.env.YANDEX_CALDAV_USERNAME = "calendar-user";
    process.env.YANDEX_CALDAV_APP_PASSWORD = "calendar-password";
    process.env.YANDEX_CALDAV_CALENDAR_URL = "https://caldav.example.test/calendar";
    process.env.CALDAV_REQUEST_TIMEOUT_MS = "1000";
    process.env.CALDAV_READBACK_TIMEOUT_MS = "1000";
    process.env.CALDAV_TOTAL_SYNC_TIMEOUT_MS = "2000";
    resetEnvCacheForTests();
    mocks.getItemCalendarSyncState.mockResolvedValue(null);
    mocks.markGoogleCalendarSync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    for (const key of [
      "CALENDAR_PROVIDER",
      "YANDEX_CALDAV_USERNAME",
      "YANDEX_CALDAV_APP_PASSWORD",
      "YANDEX_CALDAV_CALENDAR_URL",
      "CALDAV_REQUEST_TIMEOUT_MS",
      "CALDAV_READBACK_TIMEOUT_MS",
      "CALDAV_TOTAL_SYNC_TIMEOUT_MS",
    ]) {
      delete process.env[key];
    }
    resetEnvCacheForTests();
  });

  it("uses one deterministic object URL for normal PUT and read-back", async () => {
    let body = "";
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: String(init?.method) });
      if (init?.method === "PUT") {
        body = String(init.body);
        return new Response("", { status: 201 });
      }
      return new Response(body, { status: 200 });
    }));

    const result = await syncPlannerItemToYandex(item);

    expect(result.status).toBe("synced");
    expect(new Set(calls.map((call) => call.url))).toEqual(
      new Set(["https://caldav.example.test/calendar/11111111222233334444555555555555.ics"]),
    );
  });

  it("aborts a slow PUT and records pending_retry without losing the item", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
      }),
    ));

    const result = await syncPlannerItemToYandex(item, { totalTimeoutMs: 20 });

    expect(result).toEqual(expect.objectContaining({ status: "pending_retry", errorClass: "timeout" }));
    expect(mocks.markGoogleCalendarSync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        item,
        status: "pending_retry",
        lastError: "timeout",
        externalId: expect.stringMatching(/\.ics$/),
      }),
    );
  });

  it("retry GETs the same object URL and avoids PUT when the event already exists", async () => {
    const externalId = "https://caldav.example.test/calendar/existing.ics";
    mocks.getItemCalendarSyncState.mockResolvedValue({
      provider: "yandex_calendar",
      status: "pending_retry",
      externalId,
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(
        init?.method === "GET" ? `UID:${item.id}@znambo-telegram-assistant` : "",
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncPlannerItemToYandex(item, { retryFirst: true });

    expect(result.status).toBe("synced");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      externalId,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("retry PUTs and verifies the same URL only after GET returns not found", async () => {
    const externalId = "https://caldav.example.test/calendar/existing.ics";
    mocks.getItemCalendarSyncState.mockResolvedValue({
      provider: "yandex_calendar",
      status: "pending_retry",
      externalId,
    });
    let body = "";
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: String(init?.method) });
      if (calls.length === 1) return new Response("", { status: 404 });
      if (init?.method === "PUT") {
        body = String(init.body);
        return new Response(null, { status: 204 });
      }
      return new Response(body, { status: 200 });
    }));

    const result = await syncPlannerItemToYandex(item, { retryFirst: true });

    expect(result.status).toBe("synced");
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET"]);
    expect(new Set(calls.map((call) => call.url))).toEqual(new Set([externalId]));
  });
});
