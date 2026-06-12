import type { PlannerItem } from "@/db/schema";
import { getCalendarProvider } from "@/lib/env";

import { syncPlannerItemToGoogle } from "./googleCalendar";
import { syncPlannerItemToYandex } from "./yandexCalendar";

export async function syncPlannerItemToCalendar(
  item: PlannerItem,
  options?: { retryFirst?: boolean; totalTimeoutMs?: number },
) {
  const provider = getCalendarProvider();
  if (provider === "google") return syncPlannerItemToGoogle(item);
  if (provider === "yandex") return syncPlannerItemToYandex(item, options);
  return { status: "disabled" as const };
}
