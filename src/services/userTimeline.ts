import { DateTime } from "luxon";

import {
  getCalendarImportState,
  listVisibleExternalCalendarEvents,
} from "@/db/queries/externalCalendarEvents";
import type { ExternalCalendarEvent, PlannerItem, ReminderPolicy } from "@/db/schema";
import { listVisibleActivePlanItems } from "@/db/queries/items";
import { listActiveReminderPolicies } from "@/db/queries/reminderPolicies";
import type { EntityRef } from "@/domain/entityRefs";
import {
  classifyTimelineItem,
  compareTimelineEntries,
  getTimelineAnchor,
  type TimelineClassification,
} from "@/domain/timelineClassification";
import {
  parseExternalCalendarVisibilityPreferences,
  shouldShowExternalCalendarEvent,
} from "@/services/externalCalendarHygiene";
import {
  isTodayUntilDoneReminderPolicy,
  todayUntilDoneMetadataFromPolicy,
} from "@/domain/todayUntilDoneTask";

export type TimelineDateBucket =
  | "today"
  | "tomorrow"
  | "soon"
  | "overdue"
  | "past_review"
  | "unresolved_past"
  | "campaigns"
  | "long_term"
  | "history"
  | "hidden";

export type UserTimelineRow = {
  entityRef: EntityRef;
  status: string;
  dateBucket: TimelineDateBucket;
  classification: TimelineClassification | "past_review" | "unresolved_past" | "overdue";
  editable: true;
  item?: PlannerItem;
  policy?: ReminderPolicy;
};

export async function buildUserTimelineView(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const [items, policies, externalEvents, importState] = await Promise.all([
    listVisibleActivePlanItems(params.userId, 300),
    listActiveReminderPolicies(params.userId, 300),
    listVisibleExternalCalendarEvents({ userId: params.userId, limit: 500 }).catch(() => []),
    getCalendarImportState(params.userId).catch(() => null),
  ]);
  const now = params.now ?? new Date();
  const preferences = parseExternalCalendarVisibilityPreferences(importState?.metadata);
  return buildUserTimelineViewFromData({
    items,
    policies,
    externalEvents: externalEvents
      .filter((event) => shouldShowExternalCalendarEvent({ event, preferences, now }))
      .map((event) => ({
        ...event,
        metadata: {
          ...event.metadata,
          showPastExternal: preferences.showPast,
        },
      })),
    timezone: params.timezone,
    now,
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
  const policiesByItemId = new Map<string, ReminderPolicy[]>();
  for (const policy of params.policies) {
    if (!policy.itemId) continue;
    policiesByItemId.set(policy.itemId, [...(policiesByItemId.get(policy.itemId) ?? []), policy]);
  }
  const plannerItemsWithDerivedDue = params.items.map((item) =>
    withTodayUntilDoneDerivedDue(item, policiesByItemId.get(item.id) ?? [], now, params.timezone),
  );
  const rows: UserTimelineRow[] = [
    ...plannerItemsWithDerivedDue.map((item) => buildItemRow(item, now, params.timezone)),
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
      overdue: rows.filter((row) => row.dateBucket === "overdue"),
      pastReview: rows.filter((row) => row.dateBucket === "past_review"),
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
  const anchor = getTimelineAnchor({ item }, now, timezone);
  const overdue =
    item.status === "active" &&
    item.metadata?.needsReview !== true &&
    !item.metadata?.importConflict &&
    Boolean(anchor && anchor < now) &&
    item.kind !== "event" &&
    item.kind !== "tentative_event";
  const unresolvedPast =
    (item.metadata?.isExternalCalendarEvent === true &&
      item.metadata?.showPastExternal === true &&
      Boolean((item.endAt ?? item.startAt) && (item.endAt ?? item.startAt)! <= now)) ||
    (item.status === "active" &&
      Boolean(
        item.metadata?.needsReview === true ||
          item.metadata?.timeUnspecified === true ||
          item.metadata?.importConflict === true ||
          item.metadata?.orphanPolicy === true ||
          item.metadata?.invalidRecurrence === true,
      ));
  const pastReview = isPastImportantEventForReview(item, now, timezone);
  const classification = unresolvedPast
    ? "unresolved_past"
    : pastReview
      ? "past_review"
    : overdue
      ? "overdue"
    : classifyTimelineItem({ item }, now, timezone);
  const tomorrow =
    !unresolvedPast &&
    !pastReview &&
    !overdue &&
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
    snoozedUntil: null,
    priority: 3,
    source: "yandex_external",
    metadata: {
      ...event.metadata,
      externalEventId: event.id,
      calendarObjectUrl: event.calendarObjectUrl,
      calendarUid: event.uid,
      calendarEtag: event.etag,
      isExternalCalendarEvent: true,
      isRecurring: event.isRecurring,
      recurrenceRule: event.recurrenceRule,
      recurrenceId: event.recurrenceId,
    },
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function withTodayUntilDoneDerivedDue(
  item: PlannerItem,
  policies: ReminderPolicy[],
  now: Date,
  timezone: string,
): PlannerItem {
  if (item.startAt || item.dueAt) return item;
  const zone = item.timezone || timezone;
  const policy = policies.find((candidate) => {
    if (candidate.status !== "active") return false;
    if (!isTodayUntilDoneReminderPolicy(candidate) || !candidate.endsAt) return false;
    const endLocal = DateTime.fromJSDate(candidate.endsAt, { zone: "utc" }).setZone(
      candidate.timezone || zone,
    );
    const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(candidate.timezone || zone);
    return endLocal.hasSame(nowLocal, "day") || endLocal >= nowLocal;
  });
  if (!policy?.endsAt) return item;
  return {
    ...item,
    dueAt: policy.endsAt,
    metadata: {
      ...item.metadata,
      ...todayUntilDoneMetadataFromPolicy(policy),
      derivedDueAtFromPolicyId: policy.id,
    },
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
  classification: TimelineClassification | "past_review" | "unresolved_past" | "overdue",
): TimelineDateBucket {
  if (classification === "overdue") return "overdue";
  if (classification === "past_review") return "past_review";
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

function isPastImportantEventForReview(item: PlannerItem, now: Date, timezone: string) {
  if (item.status !== "active") return false;
  if (!["event", "training", "tentative_event"].includes(item.kind)) return false;
  if (item.metadata?.pastReviewOverride && typeof item.metadata.pastReviewOverride === "object") {
    const override = item.metadata.pastReviewOverride as Record<string, unknown>;
    if (override.keepInPlan === true) return false;
  }
  if (item.metadata?.allDay === true) {
    const anchor = item.startAt ?? item.dueAt;
    if (anchor) {
      const localEnd = DateTime.fromJSDate(anchor, { zone: "utc" })
        .setZone(item.timezone || timezone)
        .endOf("day");
      if (localEnd.toUTC().toJSDate() > now) return false;
    }
  }
  const endedAt = item.endAt ?? (item.startAt ? new Date(item.startAt.getTime() + 60 * 60_000) : null);
  if (!endedAt || endedAt > now) return false;
  return (
    item.priority >= 4 ||
    item.metadata?.important === true ||
    item.metadata?.importanceMode === "manual" ||
    Number(item.metadata?.basePriority ?? 0) >= 4
  );
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
