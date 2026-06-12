import type { PlannerItem } from "@/db/schema";
import { upsertCalendarSyncJob } from "@/db/queries/calendarSyncJobs";
import { syncPlannerItemToCalendar } from "@/integrations/calendar";
import { getCalendarProvider } from "@/lib/env";
import { logger } from "@/lib/logger";

export type CalendarSyncOutcome = {
  itemId: string;
  title: string;
  status: "synced" | "failed" | "pending_retry" | "disabled" | "skipped";
  provider: "yandex" | "google" | "none";
  errorClass?: string;
};

export async function syncItemsToCalendarBestEffort(items: PlannerItem[], timeoutMs = 3000) {
  const syncable = items.filter((item) =>
    ["event", "training", "tentative_event"].includes(item.kind),
  );
  if (!syncable.length) return [] as CalendarSyncOutcome[];

  return Promise.all(
    syncable.map(async (item): Promise<CalendarSyncOutcome> => {
      try {
        const result = await syncPlannerItemToCalendar(item, { totalTimeoutMs: timeoutMs });
        if (result.status === "synced") {
          return { itemId: item.id, title: item.title, status: "synced", provider: "yandex" };
        }
        if (result.status === "pending_retry" || result.status === "failed" || result.status === "error") {
          const provider = getCalendarProvider();
          if (provider === "yandex") {
            await upsertCalendarSyncJob({
              plannerItemId: item.id,
              provider: "yandex_calendar",
              status: result.status === "error" ? "failed" : result.status,
              lastError: "errorClass" in result ? result.errorClass : "unknown",
              nextAttemptAt:
                result.status === "pending_retry"
                  ? new Date(Date.now() + 60_000)
                  : null,
              payload: {
                externalIdPresent: "externalId" in result && Boolean(result.externalId),
                durationMs: "durationMs" in result ? result.durationMs : null,
              },
            });
          }
          return {
            itemId: item.id,
            title: item.title,
            status: result.status === "error" ? "failed" : result.status,
            provider: "yandex",
            errorClass: "errorClass" in result ? result.errorClass : "unknown",
          };
        }
        return {
          itemId: item.id,
          title: item.title,
          status: result.status,
          provider: "none",
        };
      } catch (error) {
        logger.warn("Calendar best-effort sync failed", {
          itemId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          itemId: item.id,
          title: item.title,
          status: "failed",
          provider: "none",
          errorClass: "unknown",
        };
      }
    }),
  );
}

export function formatCalendarSyncFeedback(results: CalendarSyncOutcome[]) {
  if (!results.length) return null;
  const synced = results.filter((result) => result.status === "synced");
  const failed = results.filter((result) => result.status === "failed");
  const pendingRetry = results.filter((result) => result.status === "pending_retry");
  const lines: string[] = [];
  if (synced.length) lines.push(`Календарь: синхронизировано в Яндекс — ${synced.length}.`);
  if (failed.length) {
    lines.push(
      `Календарь: ${failed.length} не синхронизировано; записи в JARVIS сохранены.`,
      ...failed.map((result) => `• ${result.title}: ${result.errorClass ?? result.status}`),
    );
  }
  if (pendingRetry.length) {
    lines.push(
      "Событие сохранено в JARVIS. Календарь: синхронизация задержалась, повторю автоматически.",
      ...pendingRetry.map((result) => `• ${result.title}: ${result.errorClass ?? "pending_retry"}`),
    );
  }
  return lines.join("\n");
}
