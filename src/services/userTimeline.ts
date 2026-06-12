import { DateTime } from "luxon";

import { listVisibleExternalCalendarEvents } from "@/db/queries/externalCalendarEvents";
import type { ExternalCalendarEvent, PlannerItem, ReminderPolicy } from "@/db/schema";
import { listVisibleActivePlanItems } from "@/db/queries/items";
import { listActiveReminderPolicies } from "@/db/queries/reminderPolicies";
import type { EntityRef } from "@/domain/entityRefs";
import {
  classifyTimelineItem,
  compareTimelineEntries,
  type TimelineClassification,
} from "@/domain/timelineClassification";

export type TimelineDateBucket =
  | "today"
  | "tomorrow"
  | "soon"
  | "unresolved_past"
  | "campaigns"
  | "long_term"
  | "history"
  | "hidden";

export type UserTimelineRow = {
  entityRef: EntityRef;
  status: string;
  dateBucket: TimelineDateBucket;
  classification: TimelineClassification | "unresolved_past";
  editable: true;
  item?: PlannerItem;
  policy?: ReminderPolicy;
};

export async function buildUserTimelineView(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const [items, policies, externalEvents] = await Promise.all([
    listVisibleActivePlanItems(params.userId, 300),
    listActiveReminderPolicies(params.userId, 300),
    listVisibleExternalCalendarEvents({ userId: params.userId, limit: 500 }),
  ]);
  return buildUserTimelineViewFromData({
    items,
    policies,
    externalEvents,
    timezone: params.timezone,
    now: params.now,
  });
}

export function buildUserTimelineViewFromData(params: {
  items: PlannerItem[];
  policies: ReminderPolicy[];
  externalEvents?: ExternalCalendarEvent[];
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const rows: UserTimelineRow[] = [
    ...params.items.map((item) => buildItemRow(item, now, params.timezone)),
    ...(params.externalEvents ?? []).map((event) =>
      buildItemRow(externalEventAsPlannerItem(event), now, params.timezone, {
        type: "external_calendar_event",
        id: event.id,
      }),
    ),
    ...groupCampaignPolicies(params.policies).map((policy) =>
      buildPolicyRow(policy, now, params.timezone),
    ),
  ].sort((a, b) =>
    compareTimelineEntries(
      { item: a.item, policy: a.policy },
      { item: b.item, policy: b.policy },
      now,
      params.timezone,
    ),
  );

  return {
    rows,
    items: rows.filter((row) => row.item).map((row) => row.item!),
    policies: rows.filter((row) => row.policy).map((row) => row.policy!),
    byBucket: {
      today: rows.filter((row) => row.dateBucket === "today"),
      tomorrow: rows.filter((row) => row.dateBucket === "tomorrow"),
      soon: rows.filter((row) => row.dateBucket === "soon"),
      unresolvedPast: rows.filter((row) => row.dateBucket === "unresolved_past"),
      campaigns: rows.filter((row) => row.dateBucket === "campaigns"),
      longTerm: rows.filter((row) => row.dateBucket === "long_term"),
      history: rows.filter((row) => row.dateBucket === "history"),
      hidden: rows.filter((row) => row.dateBucket === "hidden"),
    },
  };
}

function buildItemRow(
  item: PlannerItem,
  now: Date,
  timezone: string,
  entityRef?: EntityRef,
): UserTimelineRow {
  const anchor = item.startAt ?? item.dueAt;
  const unresolvedPast =
    item.status === "active" &&
    item.kind !== "event" &&
    item.kind !== "recurring_task" &&
    Boolean(anchor && anchor.getTime() < now.getTime() - 48 * 60 * 60 * 1000);
  const classification = unresolvedPast
    ? "unresolved_past"
    : classifyTimelineItem({ item }, now, timezone);
  const tomorrow =
    !unresolvedPast &&
    anchor &&
    isTomorrow(anchor, now, item.timezone || timezone);
  return {
    entityRef: entityRef ?? {
      type: classification === "history" ? "history_item" : "planner_item",
      id: item.id,
    },
    status: item.status,
    dateBucket: tomorrow ? "tomorrow" : bucketForClassification(classification),
    classification,
    editable: true,
    item,
  };
}

function externalEventAsPlannerItem(event: ExternalCalendarEvent): PlannerItem {
  return {
    id: event.id,
    userId: event.userId,
    pendingActionId: null,
    kind: "event",
    status: "active",
    title: event.summary,
    description: event.description,
    location: event.location,
    timezone: event.timezone,
    startAt: event.startAt,
    endAt: event.endAt,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "calendar_external",
    visibility: "active",
    sourcePolicyId: null,
    priority: 3,
    source: "yandex_external",
    metadata: {
      ...event.metadata,
      externalEventId: event.id,
      calendarObjectUrl: event.calendarObjectUrl,
      calendarUid: event.uid,
      calendarEtag: event.etag,
      isRecurring: event.isRecurring,
      recurrenceRule: event.recurrenceRule,
      recurrenceId: event.recurrenceId,
    },
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function isTomorrow(value: Date, now: Date, timezone: string) {
  const localNow = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  const localValue = DateTime.fromJSDate(value, { zone: "utc" }).setZone(timezone);
  return localValue.hasSame(localNow.plus({ days: 1 }), "day");
}

function buildPolicyRow(policy: ReminderPolicy, now: Date, timezone: string): UserTimelineRow {
  const classification = classifyTimelineItem({ policy }, now, timezone);
  const campaignGroup = String(policy.metadata?.campaignGroup ?? "");
  return {
    entityRef: campaignGroup
      ? { type: "campaign", id: campaignGroup }
      : { type: "reminder_policy", id: policy.id },
    status: policy.status,
    dateBucket: bucketForClassification(classification),
    classification,
    editable: true,
    policy,
  };
}

function bucketForClassification(
  classification: TimelineClassification | "unresolved_past",
): TimelineDateBucket {
  if (classification === "unresolved_past") return "unresolved_past";
  if (classification === "history") return "history";
  if (classification === "hidden") return "hidden";
  if (classification === "campaign_active" || classification === "campaign_waiting") {
    return "campaigns";
  }
  if (classification === "long_term") return "long_term";
  if (classification === "now" || classification === "today" || classification === "active_nag") {
    return "today";
  }
  return "soon";
}

function groupCampaignPolicies(policies: ReminderPolicy[]) {
  const result = new Map<string, ReminderPolicy>();
  for (const policy of policies) {
    const group = String(policy.metadata?.campaignGroup ?? "");
    const key = group || policy.id;
    const current = result.get(key);
    if (
      !current ||
      (policy.nextFireAt?.getTime() ?? Infinity) < (current.nextFireAt?.getTime() ?? Infinity)
    ) {
      result.set(key, policy);
    }
  }
  return [...result.values()];
}
