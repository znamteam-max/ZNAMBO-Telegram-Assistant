import { DateTime } from "luxon";

import { getItemCalendarSyncState } from "@/db/queries/googleCalendar";
import { writeAudit } from "@/db/queries/audit";
import { listManageableItems, updatePlannerItemDetails } from "@/db/queries/items";
import type { PlannerItem } from "@/db/schema";

const REPAIRED_TITLE = 'Сделать цитаты "норм / стрём" для эфира Больше';

export function isV290MisparsedDeadlineItem(item: PlannerItem) {
  if (
    item.status !== "active" ||
    !/сделать.*цитат.*норм\s*\/\s*стр[её]м.*эфир/i.test(item.title) ||
    !item.startAt ||
    !item.endAt
  ) {
    return false;
  }
  const start = DateTime.fromJSDate(item.startAt, { zone: "utc" }).setZone(item.timezone);
  const end = DateTime.fromJSDate(item.endAt, { zone: "utc" }).setZone(item.timezone);
  return (
    start.toFormat("yyyy-MM-dd HH:mm") === "2026-06-14 12:00" &&
    end.toFormat("yyyy-MM-dd HH:mm") === "2026-06-14 14:00"
  );
}

export async function previewV290ProductionRepair(params: { userId: string }) {
  const items = await listManageableItems(params.userId, 400);
  const deadlineMisparsedTasks = items.filter(isV290MisparsedDeadlineItem);
  const calendarUpdatesNeeded = [];
  for (const item of deadlineMisparsedTasks) {
    const sync = await getItemCalendarSyncState(item.id, "yandex_calendar").catch(() => null);
    if (sync && ["synced", "pending_retry", "failed", "error"].includes(sync.status)) {
      calendarUpdatesNeeded.push({
        itemId: item.id,
        status: sync.status,
        externalIdPresent: Boolean(sync.externalId),
      });
    }
  }
  return {
    deadlineMisparsedTasks,
    convertScheduledBlockToDeadlineOnly: deadlineMisparsedTasks.length,
    calendarUpdatesNeeded,
    safeToApply: deadlineMisparsedTasks.length === 1,
  };
}

export async function applyV290ProductionRepair(params: { userId: string }) {
  const preview = await previewV290ProductionRepair(params);
  const updatedItemIds: string[] = [];
  if (!preview.safeToApply) {
    return { preview, updatedItemIds, calendarObjectsChanged: 0 };
  }
  const item = preview.deadlineMisparsedTasks[0];
  const dueAt = DateTime.fromObject(
    { year: 2026, month: 6, day: 15, hour: 14, minute: 0 },
    { zone: item.timezone || "Europe/Moscow" },
  )
    .toUTC()
    .toJSDate();
  const updated = await updatePlannerItemDetails({
    userId: params.userId,
    itemId: item.id,
    kind: "task",
    title: REPAIRED_TITLE,
    startAt: null,
    endAt: null,
    dueAt,
    category: item.category ?? "content",
    metadata: {
      repairVersion: "2.9.0",
      repairedFromDeadlineBlock: true,
      hasDeadline: true,
      deadlineOnly: true,
      reminderSuggestion: "offer_before_deadline",
      calendarRepairDeferred: preview.calendarUpdatesNeeded.length > 0,
    },
  });
  if (updated) {
    updatedItemIds.push(updated.id);
    await writeAudit({
      userId: params.userId,
      action: "assistant.v290_deadline_item_repaired",
      entityType: "planner_item",
      entityId: updated.id,
      details: {
        repairVersion: "2.9.0",
        calendarObjectChanged: false,
        calendarUpdateNeeded: preview.calendarUpdatesNeeded.length > 0,
      },
    }).catch(() => undefined);
  }
  return { preview, updatedItemIds, calendarObjectsChanged: 0 };
}
