import type { PlannerItem, ReminderPolicy } from "@/db/schema";
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
  const [items, policies] = await Promise.all([
    listVisibleActivePlanItems(params.userId, 300),
    listActiveReminderPolicies(params.userId, 300),
  ]);
  return buildUserTimelineViewFromData({
    items,
    policies,
    timezone: params.timezone,
    now: params.now,
  });
}

export function buildUserTimelineViewFromData(params: {
  items: PlannerItem[];
  policies: ReminderPolicy[];
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const rows: UserTimelineRow[] = [
    ...params.items.map((item) => buildItemRow(item, now, params.timezone)),
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
      soon: rows.filter((row) => row.dateBucket === "soon"),
      unresolvedPast: rows.filter((row) => row.dateBucket === "unresolved_past"),
      campaigns: rows.filter((row) => row.dateBucket === "campaigns"),
      longTerm: rows.filter((row) => row.dateBucket === "long_term"),
      history: rows.filter((row) => row.dateBucket === "history"),
      hidden: rows.filter((row) => row.dateBucket === "hidden"),
    },
  };
}

function buildItemRow(item: PlannerItem, now: Date, timezone: string): UserTimelineRow {
  const anchor = item.startAt ?? item.dueAt;
  const unresolvedPast =
    item.status === "active" &&
    item.kind !== "event" &&
    item.kind !== "recurring_task" &&
    Boolean(anchor && anchor.getTime() < now.getTime() - 48 * 60 * 60 * 1000);
  const classification = unresolvedPast
    ? "unresolved_past"
    : classifyTimelineItem({ item }, now, timezone);
  return {
    entityRef: {
      type: classification === "history" ? "history_item" : "planner_item",
      id: item.id,
    },
    status: item.status,
    dateBucket: bucketForClassification(classification),
    classification,
    editable: true,
    item,
  };
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
