import { DateTime } from "luxon";

import type { PlannerItem, ReminderPolicy } from "@/db/schema";

export type TimelineClassification =
  | "now"
  | "today"
  | "active_nag"
  | "soon"
  | "distant_priority"
  | "long_term"
  | "campaign_active"
  | "campaign_waiting"
  | "history"
  | "hidden";

export type TimelineEntry = {
  item?: PlannerItem | null;
  policy?: ReminderPolicy | null;
};

export function classifyTimelineItem(
  entry: TimelineEntry,
  now: Date,
  timezone: string,
): TimelineClassification {
  const { item, policy } = entry;
  if (isHidden(item, policy)) return "hidden";
  if (item?.status === "completed" || item?.status === "cancelled" || item?.status === "archived") {
    return "history";
  }
  if (item?.visibility === "history") return "history";
  if (metadataValue(item, policy, "campaignState") === "waiting") return "campaign_waiting";
  if (metadataValue(item, policy, "campaignState") === "active") return "campaign_active";

  const anchor = item?.startAt ?? item?.dueAt ?? policy?.nextFireAt ?? policy?.startsAt ?? null;
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  const anchorLocal = anchor
    ? DateTime.fromJSDate(anchor, { zone: "utc" }).setZone(
        item?.timezone || policy?.timezone || timezone,
      )
    : null;
  const itemEnd =
    item?.endAt ?? (item?.startAt ? new Date(item.startAt.getTime() + 60 * 60 * 1000) : null);

  if (
    policy &&
    ["interval_window", "nag_until_ack"].includes(policy.policyType) &&
    (!policy.startsAt || policy.startsAt <= now) &&
    (!policy.endsAt || policy.endsAt >= now)
  ) {
    return "active_nag";
  }
  if (
    policy &&
    (["recurring", "long_term"].includes(policy.policyType) ||
      policy.category === "long_term" ||
      policy.category.startsWith("recurring_"))
  ) {
    return "long_term";
  }
  if (item?.startAt && itemEnd && item.startAt <= now && itemEnd > now) {
    return "now";
  }
  if (
    itemEnd &&
    itemEnd <= now &&
    (item?.metadata?.isExternalCalendarEvent === true ||
      ["event", "training", "tentative_event"].includes(item?.kind ?? ""))
  ) {
    return "history";
  }
  if (anchorLocal?.hasSame(nowLocal, "day")) return "today";
  if (
    anchor &&
    anchor.getTime() > now.getTime() &&
    anchor.getTime() <= now.getTime() + 48 * 60 * 60 * 1000
  )
    return "soon";
  return anchor ? "distant_priority" : "long_term";
}

export function getBasePriority(entry: TimelineEntry): number {
  const configured = Number(metadataValue(entry.item, entry.policy, "basePriority"));
  const raw =
    Number.isFinite(configured) && configured > 0 ? configured : (entry.item?.priority ?? 3);
  return clampPriority(raw);
}

export function getEffectivePriority(entry: TimelineEntry, now: Date, timezone: string): number {
  const base = getBasePriority(entry);
  const anchor =
    entry.item?.startAt ??
    entry.item?.dueAt ??
    entry.policy?.nextFireAt ??
    entry.policy?.startsAt ??
    null;
  let boost = 0;
  if (anchor) {
    const hours = (anchor.getTime() - now.getTime()) / (60 * 60 * 1000);
    if (hours < 0) boost = 2;
    else if (hours <= 3) boost = 2;
    else if (hours <= 24) boost = 1;
  }
  if (classifyTimelineItem(entry, now, timezone) === "active_nag") boost = Math.max(boost, 1);
  return clampPriority(base + boost);
}

export function getUrgencyBoost(entry: TimelineEntry, now: Date, timezone: string): number {
  return getEffectivePriority(entry, now, timezone) - getBasePriority(entry);
}

export function compareTimelineEntries(
  a: TimelineEntry,
  b: TimelineEntry,
  now: Date,
  timezone: string,
) {
  const effective = getEffectivePriority(b, now, timezone) - getEffectivePriority(a, now, timezone);
  if (effective) return effective;
  const rank =
    classificationRank(classifyTimelineItem(a, now, timezone)) -
    classificationRank(classifyTimelineItem(b, now, timezone));
  if (rank) return rank;
  const base = getBasePriority(b) - getBasePriority(a);
  if (base) return base;
  return entryTime(a) - entryTime(b);
}

function metadataValue(
  item: PlannerItem | null | undefined,
  policy: ReminderPolicy | null | undefined,
  key: string,
) {
  return policy?.metadata?.[key] ?? item?.metadata?.[key] ?? null;
}

function isHidden(item?: PlannerItem | null, policy?: ReminderPolicy | null) {
  return (
    item?.visibility === "hidden" ||
    item?.metadata?.isTest === true ||
    item?.metadata?.debug === true ||
    item?.metadata?.garbage === true ||
    policy?.status === "cancelled" ||
    policy?.status === "completed" ||
    policy?.status === "expired"
  );
}

function entryTime(entry: TimelineEntry) {
  return (
    (
      entry.item?.startAt ??
      entry.item?.dueAt ??
      entry.policy?.nextFireAt ??
      entry.policy?.startsAt
    )?.getTime() ?? Number.MAX_SAFE_INTEGER
  );
}

function classificationRank(value: TimelineClassification) {
  return {
    now: 0,
    active_nag: 1,
    today: 2,
    soon: 3,
    campaign_active: 4,
    campaign_waiting: 5,
    distant_priority: 6,
    long_term: 7,
    history: 8,
    hidden: 9,
  }[value];
}

function clampPriority(value: number) {
  return Math.max(1, Math.min(5, Math.round(value)));
}
