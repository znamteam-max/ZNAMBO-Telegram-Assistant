import type { PlannerItem } from "@/db/schema";
import { syncPlannerItemToCalendar } from "@/integrations/calendar";
import { logger } from "@/lib/logger";

export async function syncItemsToCalendarBestEffort(items: PlannerItem[], timeoutMs = 3000) {
  const syncable = items.filter((item) =>
    ["event", "training", "tentative_event"].includes(item.kind),
  );
  if (!syncable.length) return;

  await Promise.race([
    Promise.allSettled(syncable.map((item) => syncPlannerItemToCalendar(item))),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]).catch((error) => {
    logger.warn("Calendar best-effort sync failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
