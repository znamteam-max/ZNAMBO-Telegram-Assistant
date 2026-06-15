import {
  listCompletedPlannerItems,
  listManageableItems,
  updatePlannerItemDetails,
} from "@/db/queries/items";
import {
  listRecentAgentActions,
  listPendingAgentActionsByTypes,
  updateAgentAction,
} from "@/db/queries/agentActions";
import {
  listActiveReminderPolicies,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelPendingRemindersForPolicy } from "@/db/queries/reminders";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";

export async function previewV2140ProductionRepair(params: { userId: string; now?: Date }) {
  const [items, policies, sessions, completed, recentActions] = await loadData(params.userId);
  const genericEventReminderPolicyIds = policies
    .filter((policy) => isGenericBeforeEventPolicy(policy, items))
    .map((policy) => policy.id);
  const staleRecurringDraftIds = sessions
    .filter((action) => action.actionType === "recurring_policy_draft")
    .filter(isStaleOrContradictoryDraft)
    .map((action) => action.id);
  const duplicateMirrorPolicyIds = duplicateMirrorPolicies(policies).map((policy) => policy.id);
  const completedInvisibleItemIds = completed
    .filter((item) => item.visibility === "hidden")
    .map((item) => item.id);
  const overdueAsUnresolvedItemIds = items
    .filter((item) => isOverdueItem(item, params.now ?? new Date()))
    .filter((item) => item.metadata?.needsReview === true || item.metadata?.timeUnspecified === true)
    .map((item) => item.id);
  const contradictoryDraftActionIds = recentActions
    .filter((action) =>
      ["recurring_policy_draft", "recurring_policy_duplicate_decision"].includes(
        action.actionType,
      ),
    )
    .filter(hasContradictoryDraftState)
    .map((action) => action.id);

  return {
    overdueAsUnresolvedItemIds,
    genericEventReminderPolicyIds,
    staleRecurringDraftIds,
    duplicateMirrorPolicyIds,
    completedInvisibleItemIds,
    contradictoryDraftActionIds,
    calendarObjectsToChange: 0,
    safeToApply: true,
    notes: [
      `overdue-as-unresolved items: ${overdueAsUnresolvedItemIds.length}`,
      `generic before-event reminders: ${genericEventReminderPolicyIds.length}`,
      `stale/contradictory recurring drafts: ${staleRecurringDraftIds.length}`,
      `duplicate mirror recurring policies: ${duplicateMirrorPolicyIds.length}`,
      `completed invisible items: ${completedInvisibleItemIds.length}`,
      `contradictory draft action rows: ${contradictoryDraftActionIds.length}`,
      "Yandex Calendar objects will not be changed",
    ],
  };
}

export async function applyV2140ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const preview = await previewV2140ProductionRepair({ ...params, now });
  const [items, policies, sessions, completed, recentActions] = await loadData(params.userId);
  const normalizedItemIds: string[] = [];
  const normalizedPolicyIds: string[] = [];
  const cancelledPolicyIds: string[] = [];
  const clearedDraftIds: string[] = [];
  const normalizedDraftActionIds: string[] = [];

  for (const item of items.filter((candidate) =>
    preview.overdueAsUnresolvedItemIds.includes(candidate.id),
  )) {
    const updated = await updatePlannerItemDetails({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        needsReview: false,
        timeUnspecified: false,
        repairedBy: "admin_repair_v2140",
        repairedAt: now.toISOString(),
      },
    });
    if (updated) normalizedItemIds.push(updated.id);
  }

  for (const policy of policies.filter((candidate) =>
    preview.genericEventReminderPolicyIds.includes(candidate.id),
  )) {
    const item = items.find((candidate) => candidate.id === policy.itemId);
    const metadata = inferBeforeEventMetadata(policy, item);
    if (!metadata) {
      await cancelPendingRemindersForPolicy({
        userId: params.userId,
        policyId: policy.id,
        from: now,
      });
      const paused = await updateReminderPolicy({
        userId: params.userId,
        policyId: policy.id,
        status: "paused",
        nextFireAt: null,
        metadata: {
          needsReview: true,
          reviewReason: "before_event_offset_unknown",
          repairedBy: "admin_repair_v2140",
          repairedAt: now.toISOString(),
        },
      });
      if (paused) normalizedPolicyIds.push(paused.id);
      continue;
    }
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      metadata: {
        ...metadata,
        repairedBy: "admin_repair_v2140",
        repairedAt: now.toISOString(),
      },
    });
    if (updated) normalizedPolicyIds.push(updated.id);
  }

  for (const policy of policies.filter((candidate) =>
    preview.duplicateMirrorPolicyIds.includes(candidate.id),
  )) {
    await cancelPendingRemindersForPolicy({
      userId: params.userId,
      policyId: policy.id,
      from: now,
    });
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      status: "cancelled",
      nextFireAt: null,
      metadata: {
        cancelledBy: "admin_repair_v2140",
        cancelReason: "duplicate_mirror_recurring_policy",
        cancelledAt: now.toISOString(),
      },
    });
    if (updated) cancelledPolicyIds.push(updated.id);
  }

  for (const action of sessions.filter((candidate) =>
    preview.staleRecurringDraftIds.includes(candidate.id),
  )) {
    const updated = await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...(action.output ?? {}),
        cancelledBy: "admin_repair_v2140",
        cancelledReason: "stale_or_contradictory_recurring_draft",
        cancelledAt: now.toISOString(),
      },
    });
    if (updated) clearedDraftIds.push(updated.id);
  }

  for (const item of completed.filter((candidate) =>
    preview.completedInvisibleItemIds.includes(candidate.id),
  )) {
    const updated = await updatePlannerItemDetails({
      userId: params.userId,
      itemId: item.id,
      visibility: "history",
      metadata: {
        repairedBy: "admin_repair_v2140",
        repairedAt: now.toISOString(),
      },
    });
    if (updated) normalizedItemIds.push(updated.id);
  }

  for (const action of recentActions.filter((candidate) =>
    preview.contradictoryDraftActionIds.includes(candidate.id),
  )) {
    const status = action.status === "completed" ? "completed" : "cancelled";
    const updated = await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status,
      output: {
        ...(action.output ?? {}),
        repairedBy: "admin_repair_v2140",
        repairedAt: now.toISOString(),
      },
    });
    if (updated) normalizedDraftActionIds.push(updated.id);
  }

  return {
    ...preview,
    normalizedItemIds,
    normalizedPolicyIds,
    cancelledPolicyIds,
    clearedDraftIds,
    normalizedDraftActionIds,
  };
}

async function loadData(userId: string) {
  return Promise.all([
    listManageableItems(userId, 500),
    listActiveReminderPolicies(userId, 500),
    listPendingAgentActionsByTypes({
      userId,
      actionTypes: ["recurring_policy_draft", "recurring_policy_duplicate_decision"],
      limit: 100,
    }),
    listCompletedPlannerItems({ userId, limit: 200, includeArchived: true }),
    listRecentAgentActions({ userId, limit: 500 }),
  ]);
}

function isGenericBeforeEventPolicy(policy: ReminderPolicy, items: PlannerItem[]) {
  if (policy.policyType !== "before_event" || !policy.itemId) return false;
  if (policy.metadata?.minutesBefore || policy.metadata?.relativeLabel) return false;
  return Boolean(items.find((item) => item.id === policy.itemId && (item.startAt || item.dueAt)));
}

function inferBeforeEventMetadata(policy: ReminderPolicy, item?: PlannerItem | null) {
  const anchor = item?.startAt ?? item?.dueAt ?? null;
  const fireAt = policy.nextFireAt ?? policy.startsAt ?? null;
  if (!anchor || !fireAt) return null;
  const minutesBefore = Math.round((anchor.getTime() - fireAt.getTime()) / 60_000);
  if (!Number.isFinite(minutesBefore) || minutesBefore <= 0) return null;
  return { minutesBefore, relativeLabel: formatBeforeEventLabel(minutesBefore, fireAt, item?.timezone ?? policy.timezone) };
}

function isStaleOrContradictoryDraft(action: AgentAction) {
  const output = action.output ?? {};
  if (output.committedAt && output.cancelledAt) return true;
  const expiresAt = typeof output.expiresAt === "string" ? new Date(output.expiresAt) : null;
  return Boolean(expiresAt && expiresAt < new Date());
}

function hasContradictoryDraftState(action: AgentAction) {
  const output = action.output ?? {};
  return Boolean(
    (output.committedAt || output.completedAt) &&
      (output.cancelledAt || output.cancelledReason),
  );
}

function duplicateMirrorPolicies(policies: ReminderPolicy[]) {
  const groups = new Map<string, ReminderPolicy[]>();
  for (const policy of policies.filter(isMirrorPolicy)) {
    const key = `${normalize(policy.title)}|${policy.recurrenceRule ?? "none"}`;
    groups.set(key, [...(groups.get(key) ?? []), policy]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .flatMap((group) =>
      group
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
        .slice(1),
    );
}

function isMirrorPolicy(policy: ReminderPolicy) {
  return (
    ["recurring", "long_term"].includes(policy.policyType) &&
    /зеркал/i.test(policy.title) &&
    policy.status === "active"
  );
}

function isOverdueItem(item: PlannerItem, now: Date) {
  const anchor = item.startAt ?? item.dueAt;
  return Boolean(anchor && anchor < now && item.status === "active" && item.kind !== "event");
}

function normalize(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function formatBeforeEventLabel(minutes: number, fireAt: Date, timezone: string) {
  const clock = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).format(fireAt);
  if (minutes === 10) return "за 10 минут";
  if (minutes === 30) return "за 30 минут";
  if (minutes === 60) return "за час";
  if (minutes === 120) return "за 2 часа";
  if (minutes >= 24 * 60 && minutes <= 48 * 60) return `за день в ${clock}`;
  return `за ${minutes} минут`;
}
