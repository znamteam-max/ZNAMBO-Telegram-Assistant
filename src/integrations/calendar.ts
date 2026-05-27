import type { PlannerItem } from "@/db/schema";
import { getCalendarProvider } from "@/lib/env";

import { syncPlannerItemToGoogle } from "./googleCalendar";
import { syncPlannerItemToYandex } from "./yandexCalendar";

export async function syncPlannerItemToCalendar(item: PlannerItem) {
  const provider = getCalendarProvider();
  if (provider === "google") return syncPlannerItemToGoogle(item);
  if (provider === "yandex") return syncPlannerItemToYandex(item);
  return { status: "disabled" as const };
}
