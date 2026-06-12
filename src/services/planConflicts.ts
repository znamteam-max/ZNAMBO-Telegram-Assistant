import { DateTime } from "luxon";

import type { PlannerItem } from "@/db/schema";

const EVENT_LIKE_KINDS = new Set(["event", "training", "tentative_event"]);
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

export type PlanConflict = {
  first: PlannerItem;
  second: PlannerItem;
  overlapStart: Date;
  overlapEnd: Date;
};

export function detectPlanConflicts(items: PlannerItem[]): PlanConflict[] {
  const candidates = items
    .filter((item) => item.status === "active" && EVENT_LIKE_KINDS.has(item.kind) && item.startAt)
    .map((item) => ({
      item,
      start: item.startAt!,
      end: item.endAt ?? new Date(item.startAt!.getTime() + DEFAULT_DURATION_MS),
    }))
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  const conflicts: PlanConflict[] = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      if (right.start >= left.end) break;
      if (left.start < right.end && right.start < left.end) {
        conflicts.push({
          first: left.item,
          second: right.item,
          overlapStart: new Date(Math.max(left.start.getTime(), right.start.getTime())),
          overlapEnd: new Date(Math.min(left.end.getTime(), right.end.getTime())),
        });
      }
    }
  }
  return conflicts;
}

export function formatConflictLine(conflict: PlanConflict, timezone: string) {
  const zone = conflict.first.timezone || conflict.second.timezone || timezone;
  const when = DateTime.fromJSDate(conflict.overlapStart, { zone: "utc" })
    .setZone(zone)
    .toFormat("dd.LL HH:mm");
  return `⚠️ ${when} · ${conflict.second.title} пересекается с «${conflict.first.title}»`;
}
