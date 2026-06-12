import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlannerItem } from "@/db/schema";
import { resetEnvCacheForTests } from "@/lib/env";

const mocks = vi.hoisted(() => ({
  listDueCalendarSyncJobs: vi.fn(),
  listRetryableCalendarSyncJobsForUser: vi.fn(),
  upsertCalendarSyncJob: vi.fn(),
  listCalendarSyncStatesForUser: vi.fn(),
  syncPlannerItemToCalendar: vi.fn(),
}));

vi.mock("@/db/queries/calendarSyncJobs", () => ({
  listDueCalendarSyncJobs: mocks.listDueCalendarSyncJobs,
  listRetryableCalendarSyncJobsForUser: mocks.listRetryableCalendarSyncJobsForUser,
  upsertCalendarSyncJob: mocks.upsertCalendarSyncJob,
}));
vi.mock("@/db/queries/googleCalendar", () => ({
  listCalendarSyncStatesForUser: mocks.listCalendarSyncStatesForUser,
}));
vi.mock("@/integrations/calendar", () => ({
  syncPlannerItemToCalendar: mocks.syncPlannerItemToCalendar,
}));

import { retryCalendarSyncsForUser } from "@/services/calendarSyncRetry";

const item = {
  id: "item-id",
  userId: "user-id",
  kind: "event",
  status: "active",
  title: "Отвести Роба к ортодонту",
  startAt: new Date("2026-06-16T07:20:00.000Z"),
} as PlannerItem;

describe("V2.5.3.1 calendar retry queue", () => {
  beforeEach(() => {
    process.env.CALENDAR_PROVIDER = "yandex";
    process.env.YANDEX_CALDAV_USERNAME = "user";
    process.env.YANDEX_CALDAV_APP_PASSWORD = "password";
    resetEnvCacheForTests();
    mocks.listRetryableCalendarSyncJobsForUser.mockResolvedValue([]);
    mocks.listCalendarSyncStatesForUser.mockResolvedValue([]);
    mocks.upsertCalendarSyncJob.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.CALENDAR_PROVIDER;
    delete process.env.YANDEX_CALDAV_USERNAME;
    delete process.env.YANDEX_CALDAV_APP_PASSWORD;
    resetEnvCacheForTests();
  });

  it("retries a failed timeout item even when the old failure has no queue job", async () => {
    mocks.listCalendarSyncStatesForUser.mockResolvedValue([
      { item, sync: { status: "error", lastError: "timeout" } },
    ]);
    mocks.syncPlannerItemToCalendar.mockResolvedValue({
      status: "synced",
      externalId: "https://caldav.example.test/item.ics",
      durationMs: 42,
    });

    const result = await retryCalendarSyncsForUser({ userId: "user-id", timeoutOnly: true });

    expect(result.synced).toBe(1);
    expect(mocks.syncPlannerItemToCalendar).toHaveBeenCalledWith(
      item,
      expect.objectContaining({ retryFirst: true }),
    );
    expect(mocks.upsertCalendarSyncJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ plannerItemId: item.id, status: "synced" }),
    );
  });

  it("keeps a retry queued when the full retry still times out", async () => {
    mocks.listRetryableCalendarSyncJobsForUser.mockResolvedValue([
      { item, job: { status: "pending_retry" } },
    ]);
    mocks.syncPlannerItemToCalendar.mockResolvedValue({
      status: "pending_retry",
      errorClass: "timeout",
      externalId: "https://caldav.example.test/item.ics",
      durationMs: 30_000,
    });

    const result = await retryCalendarSyncsForUser({ userId: "user-id" });

    expect(result.pendingRetry).toBe(1);
    expect(mocks.upsertCalendarSyncJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        plannerItemId: item.id,
        status: "pending_retry",
        lastError: "timeout",
        nextAttemptAt: expect.any(Date),
      }),
    );
  });
});
