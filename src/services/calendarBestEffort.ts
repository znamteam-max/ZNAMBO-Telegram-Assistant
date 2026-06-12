import type { PlannerItem } from "@/db/schema";
import { syncPlannerItemToCalendar } from "@/integrations/calendar";
import { logger } from "@/lib/logger";

export type CalendarSyncOutcome = {
  itemId: string;
  title: string;
  status: "synced" | "failed" | "disabled" | "skipped" | "timeout";
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
        const result = await withTimeout(syncPlannerItemToCalendar(item), timeoutMs);
        if (result === "timeout") {
          return { itemId: item.id, title: item.title, status: "timeout", provider: "none" };
        }
        if (result.status === "synced") {
          return { itemId: item.id, title: item.title, status: "synced", provider: "yandex" };
        }
        if (result.status === "error") {
          return {
            itemId: item.id,
            title: item.title,
            status: "failed",
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
  const failed = results.filter((result) => result.status === "failed" || result.status === "timeout");
  const lines: string[] = [];
  if (synced.length) lines.push(`Календарь: синхронизировано в Яндекс — ${synced.length}.`);
  if (failed.length) {
    lines.push(
      `Календарь: ${failed.length} не синхронизировано; записи в JARVIS сохранены.`,
      ...failed.map((result) => `• ${result.title}: ${result.errorClass ?? result.status}`),
    );
  }
  return lines.join("\n");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);
}
