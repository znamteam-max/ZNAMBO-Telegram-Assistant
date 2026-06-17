import { DateTime } from "luxon";

import { listManageableItems, updatePlannerItemDetails } from "@/db/queries/items";
import { writeAudit } from "@/db/queries/audit";

import {
  applyV2200ProductionRepair,
  previewV2200ProductionRepair,
} from "./v2200ProductionRepair";

type TimezoneCandidate = {
  itemId: string;
  title: string;
  currentTimezone: string;
  ownerTimezone: string;
  currentLocal: string;
  ownerLocal: string;
  repairAction: "set_owner_timezone" | "shift_plus_3h_and_set_owner_timezone";
};

export async function previewV2210ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const base = await previewV2200ProductionRepair(params);
  const timezoneShiftedEventCandidates = await collectTimezoneCandidates(params);
  return {
    ...base,
    timezoneShiftedEventCandidates,
    timezoneShiftedEvents: timezoneShiftedEventCandidates.length,
    postilnyConcertCandidates: timezoneShiftedEventCandidates.filter((candidate) =>
      /постил|вадим/i.test(candidate.title),
    ).length,
    monthlyDayRangeAuditActions: [
      "assistant.monthly_day_range_occurrence_checked",
      "assistant.monthly_day_range_occurrence_materialized",
      "assistant.monthly_day_range_occurrence_missed_review",
    ],
    calendarObjectsToChange: 0 as const,
    safeToApply: true as const,
    notes: [
      ...(base.notes ?? []),
      `timezone shifted event candidates: ${timezoneShiftedEventCandidates.length}`,
      "V2.21 repair is calendar-safe; Yandex objects are not mutated",
    ],
  };
}

export async function applyV2210ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const base = await applyV2200ProductionRepair(params);
  const timezoneShiftedEventCandidates = await collectTimezoneCandidates(params);
  const repairedTimezoneItemIds: string[] = [];

  for (const candidate of timezoneShiftedEventCandidates) {
    const items = await listManageableItems(params.userId, 500);
    const item = items.find((entry) => entry.id === candidate.itemId);
    if (!item?.startAt) continue;
    const shiftMs =
      candidate.repairAction === "shift_plus_3h_and_set_owner_timezone" ? 3 * 60 * 60_000 : 0;
    const updated = await updatePlannerItemDetails({
      userId: params.userId,
      itemId: item.id,
      timezone: params.timezone,
      startAt: shiftMs ? new Date(item.startAt.getTime() + shiftMs) : item.startAt,
      endAt: item.endAt ? new Date(item.endAt.getTime() + shiftMs) : item.endAt,
      dueAt: item.dueAt ? new Date(item.dueAt.getTime() + shiftMs) : item.dueAt,
      metadata: {
        repairedBy: "admin_repair_v2210",
        repairedAt: now.toISOString(),
        repairReason: "owner_timezone_display_shift",
        previousTimezone: item.timezone,
        repairAction: candidate.repairAction,
        sourceTimezone: params.timezone,
      },
    });
    if (updated) {
      repairedTimezoneItemIds.push(updated.id);
      await writeAudit({
        userId: params.userId,
        action: "assistant.owner_timezone_event_repaired",
        entityType: "planner_item",
        entityId: updated.id,
        details: {
          repairAction: candidate.repairAction,
          previousTimezone: item.timezone,
          ownerTimezone: params.timezone,
          previousStartAt: item.startAt.toISOString(),
          updatedStartAt: updated.startAt?.toISOString() ?? null,
          calendarObjectsChanged: 0,
        },
      }).catch(() => undefined);
    }
  }

  return {
    ...base,
    timezoneShiftedEventCandidates,
    timezoneShiftedEvents: timezoneShiftedEventCandidates.length,
    postilnyConcertCandidates: timezoneShiftedEventCandidates.filter((candidate) =>
      /постил|вадим/i.test(candidate.title),
    ).length,
    repairedTimezoneItemIds,
    monthlyDayRangeAuditActions: [
      "assistant.monthly_day_range_occurrence_checked",
      "assistant.monthly_day_range_occurrence_materialized",
      "assistant.monthly_day_range_occurrence_missed_review",
    ],
    calendarObjectsChanged: 0 as const,
    calendarObjectsToChange: 0 as const,
    safeToApply: true as const,
  };
}

async function collectTimezoneCandidates(params: { userId: string; timezone: string }) {
  const candidates: TimezoneCandidate[] = [];
  const items = await listManageableItems(params.userId, 500);
  for (const item of items) {
    if (!item.startAt || !["event", "training", "tentative_event"].includes(item.kind)) continue;
    const itemZone = item.timezone || params.timezone;
    const currentLocal = DateTime.fromJSDate(item.startAt, { zone: "utc" }).setZone(itemZone);
    const ownerLocal = DateTime.fromJSDate(item.startAt, { zone: "utc" }).setZone(params.timezone);
    const postilny = /постил|вадим/i.test(item.title);
    if (!postilny) continue;
    if (itemZone !== params.timezone && currentLocal.hour === 18 && currentLocal.minute === 30) {
      candidates.push({
        itemId: item.id,
        title: item.title,
        currentTimezone: itemZone,
        ownerTimezone: params.timezone,
        currentLocal: currentLocal.toFormat("yyyy-MM-dd HH:mm"),
        ownerLocal: ownerLocal.toFormat("yyyy-MM-dd HH:mm"),
        repairAction: "set_owner_timezone",
      });
      continue;
    }
    if (ownerLocal.hour === 18 && ownerLocal.minute === 30) {
      candidates.push({
        itemId: item.id,
        title: item.title,
        currentTimezone: itemZone,
        ownerTimezone: params.timezone,
        currentLocal: currentLocal.toFormat("yyyy-MM-dd HH:mm"),
        ownerLocal: ownerLocal.toFormat("yyyy-MM-dd HH:mm"),
        repairAction: "shift_plus_3h_and_set_owner_timezone",
      });
    }
  }
  return candidates;
}
