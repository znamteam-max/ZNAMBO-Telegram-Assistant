import {
  listDueCalendarSyncJobs,
  listRetryableCalendarSyncJobsForUser,
  upsertCalendarSyncJob,
} from "@/db/queries/calendarSyncJobs";
import { listCalendarSyncStatesForUser } from "@/db/queries/googleCalendar";
import type { PlannerItem } from "@/db/schema";
import { syncPlannerItemToCalendar } from "@/integrations/calendar";
import { getCalendarProvider, getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

export type CalendarRetryResult = {
  itemId: string;
  title: string;
  status: "synced" | "pending_retry" | "failed" | "disabled" | "skipped";
  errorClass: string | null;
};

export async function runDueCalendarSyncRetries(params?: { now?: Date; limit?: number }) {
  if (getCalendarProvider() !== "yandex") return { checked: 0, synced: 0, pendingRetry: 0, failed: 0 };
  const rows = await listDueCalendarSyncJobs(params?.now ?? new Date(), params?.limit ?? 20);
  return summarize(await Promise.all(rows.map(({ item }) => retryCalendarItem(item))));
}

export async function retryCalendarSyncsForUser(params: {
  userId: string;
  timeoutOnly?: boolean;
  limit?: number;
}) {
  const limit = params.limit ?? 100;
  const [jobs, states] = await Promise.all([
    listRetryableCalendarSyncJobsForUser(params.userId, limit),
    listCalendarSyncStatesForUser(params.userId, limit),
  ]);
  const items = new Map<string, PlannerItem>();
  for (const { item } of jobs) items.set(item.id, item);
  for (const { sync, item } of states) {
    if (!["error", "failed", "pending_retry", "not_synced", "pending"].includes(sync.status)) continue;
    if (params.timeoutOnly && sync.lastError !== "timeout") continue;
    items.set(item.id, item);
  }
  const results = await Promise.all([...items.values()].slice(0, limit).map(retryCalendarItem));
  return { ...summarize(results), results };
}

export async function retryCalendarItems(items: PlannerItem[]) {
  const results = await Promise.all(items.map(retryCalendarItem));
  return { ...summarize(results), results };
}

export async function retryCalendarItem(item: PlannerItem): Promise<CalendarRetryResult> {
  const provider = getCalendarProvider();
  if (provider !== "yandex") {
    return { itemId: item.id, title: item.title, status: "disabled", errorClass: null };
  }
  await upsertCalendarSyncJob({
    plannerItemId: item.id,
    provider: "yandex_calendar",
    status: "syncing",
    nextAttemptAt: null,
    incrementAttempt: true,
    payload: { retryFirst: true },
  });
  try {
    const result = await syncPlannerItemToCalendar(item, {
      retryFirst: true,
      totalTimeoutMs: getEnv().CALDAV_TOTAL_SYNC_TIMEOUT_MS,
    });
    if (result.status === "synced") {
      const durationMs = "durationMs" in result ? result.durationMs : null;
      await upsertCalendarSyncJob({
        plannerItemId: item.id,
        provider: "yandex_calendar",
        status: "synced",
        lastError: null,
        nextAttemptAt: null,
        payload: { externalIdPresent: true, durationMs, retryFirst: true },
      });
      return { itemId: item.id, title: item.title, status: "synced", errorClass: null };
    }
    if (result.status === "pending_retry" || result.status === "failed" || result.status === "error") {
      const status = result.status === "error" ? "failed" : result.status;
      const errorClass = "errorClass" in result ? result.errorClass : "unknown";
      await upsertCalendarSyncJob({
        plannerItemId: item.id,
        provider: "yandex_calendar",
        status,
        lastError: errorClass,
        nextAttemptAt:
          status === "pending_retry"
            ? new Date(Date.now() + retryDelayMs(item.id))
            : null,
        payload: {
          externalIdPresent: "externalId" in result && Boolean(result.externalId),
          durationMs: "durationMs" in result ? result.durationMs : null,
          retryFirst: true,
        },
      });
      return {
        itemId: item.id,
        title: item.title,
        status,
        errorClass,
      };
    }
    await upsertCalendarSyncJob({
      plannerItemId: item.id,
      provider: "yandex_calendar",
      status: "disabled",
      nextAttemptAt: null,
      payload: { retryFirst: true },
    });
    return { itemId: item.id, title: item.title, status: result.status, errorClass: null };
  } catch (error) {
    logger.warn("Calendar retry failed unexpectedly", {
      itemId: item.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await upsertCalendarSyncJob({
      plannerItemId: item.id,
      provider: "yandex_calendar",
      status: "pending_retry",
      lastError: "unknown",
      nextAttemptAt: new Date(Date.now() + retryDelayMs(item.id)),
      payload: { retryFirst: true },
    });
    return { itemId: item.id, title: item.title, status: "pending_retry", errorClass: "unknown" };
  }
}

function retryDelayMs(itemId: string) {
  const jitterSeconds = [...itemId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 30;
  return (2 * 60 + jitterSeconds) * 1000;
}

function summarize(results: CalendarRetryResult[]) {
  return {
    checked: results.length,
    synced: results.filter((result) => result.status === "synced").length,
    pendingRetry: results.filter((result) => result.status === "pending_retry").length,
    failed: results.filter((result) => result.status === "failed").length,
  };
}
