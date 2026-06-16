import {
  cancelPlannerItemWithMetadata,
  listManageableItems,
  mergePlannerItemMetadata,
} from "@/db/queries/items";
import { listPendingAgentActionsByTypes, updateAgentAction } from "@/db/queries/agentActions";
import { listActiveReminderPolicies, updateReminderPolicy } from "@/db/queries/reminderPolicies";
import { cancelItemReminderChains, cancelPendingRemindersForPolicy } from "@/db/queries/reminders";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";
import {
  formatBeforeEventOffset,
  getBeforeEventPolicyKey,
  getEventLinkedReminderOffsetMinutes,
} from "@/domain/reminderPolicyPresentation";

const STALE_SESSION_TYPES = [
  "multi_reminder_setup_session",
  "reminder_policy_edit_session",
  "event_target_resolution",
  "reminder_target_resolution",
];

export type V2180RepairCandidates = {
  duplicateBeforeEventPolicyIds: string[];
  genericBeforeEventPolicyIds: string[];
  pastImportantEventIds: string[];
  staleReminderSessionActionIds: string[];
  fakeReminderItemIds: string[];
  calendarObjectsToChange: 0;
  safeToApply: true;
};

export async function previewV2180ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const [items, policies, sessions] = await loadData(params.userId);
  const candidates = collectV2180ProductionRepairCandidates({
    items,
    policies,
    sessions,
    now,
  });
  return {
    ...candidates,
    genericBeforeEventPolicies: candidates.genericBeforeEventPolicyIds.length,
    duplicateBeforeEventOffsets: candidates.duplicateBeforeEventPolicyIds.length,
    pastImportantEvents: candidates.pastImportantEventIds.length,
    staleReminderSessions: candidates.staleReminderSessionActionIds.length,
    fakeReminderRows: candidates.fakeReminderItemIds.length,
    notes: [
      `generic before-event policies: ${candidates.genericBeforeEventPolicyIds.length}`,
      `duplicate before-event offsets: ${candidates.duplicateBeforeEventPolicyIds.length}`,
      `past important events: ${candidates.pastImportantEventIds.length}`,
      `stale reminder sessions: ${candidates.staleReminderSessionActionIds.length}`,
      `fake reminder rows: ${candidates.fakeReminderItemIds.length}`,
      "Yandex Calendar objects will not be changed",
    ],
  };
}

export async function applyV2180ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const preview = await previewV2180ProductionRepair({ ...params, now });
  const [items, policies, sessions] = await loadData(params.userId);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const cancelledDuplicatePolicyIds: string[] = [];
  const inferredBeforeEventPolicyIds: string[] = [];
  const reviewRequiredPolicyIds: string[] = [];
  const markedPastReviewItemIds: string[] = [];
  const clearedReminderSessionActionIds: string[] = [];
  const cancelledFakeReminderItemIds: string[] = [];

  for (const policy of policies.filter((candidate) =>
    preview.duplicateBeforeEventPolicyIds.includes(candidate.id),
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
        repairedBy: "admin_repair_v2180",
        repairReason: "duplicate_before_event_offset",
        repairedAt: now.toISOString(),
      },
    });
    if (updated) cancelledDuplicatePolicyIds.push(updated.id);
  }

  for (const policy of policies.filter((candidate) =>
    preview.genericBeforeEventPolicyIds.includes(candidate.id),
  )) {
    const item = itemsById.get(policy.itemId ?? "");
    const inferred = item ? inferBeforeEventPolicy(policy, item) : null;
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      ...(inferred
        ? {
            policyType: "before_event",
            category: "pre_event",
            startsAt: inferred.fireAt,
            nextFireAt: inferred.fireAt,
            metadata: {
              repairedBy: "admin_repair_v2180",
              repairReason: "generic_before_event_inferred_from_fire_at",
              repairedAt: now.toISOString(),
              minutesBefore: inferred.minutesBefore,
              relativeLabel: formatBeforeEventOffset(
                inferred.minutesBefore,
                inferred.fireAt,
                item?.timezone || policy.timezone,
              ),
              reviewRequired: false,
              reviewedAt: now.toISOString(),
            },
          }
        : {
            metadata: {
              repairedBy: "admin_repair_v2180",
              repairReason: "generic_before_event_needs_review",
              repairedAt: now.toISOString(),
              reviewRequired: true,
              reviewReason: "before_event_offset_not_inferable",
              reviewedAt: null,
            },
          }),
    });
    if (!updated) continue;
    if (inferred) inferredBeforeEventPolicyIds.push(updated.id);
    else reviewRequiredPolicyIds.push(updated.id);
  }

  for (const item of items.filter((candidate) =>
    preview.pastImportantEventIds.includes(candidate.id),
  )) {
    const updated = await mergePlannerItemMetadata({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        pastReviewRequiredAt: now.toISOString(),
        pastReviewReason: "ended_important_event",
        repairedBy: "admin_repair_v2180",
      },
    });
    if (updated) markedPastReviewItemIds.push(updated.id);
  }

  for (const action of sessions.filter((candidate) =>
    preview.staleReminderSessionActionIds.includes(candidate.id),
  )) {
    const updated = await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...(action.output ?? {}),
        cancelledReason: "admin_repair_v2180_stale_reminder_session",
        cancelledAt: now.toISOString(),
      },
    });
    if (updated) clearedReminderSessionActionIds.push(updated.id);
  }

  for (const item of items.filter((candidate) =>
    preview.fakeReminderItemIds.includes(candidate.id),
  )) {
    const cancelled = await cancelPlannerItemWithMetadata({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        archivedBy: "admin_repair_v2180",
        archiveReason: "fake_standalone_reminder_row",
        archivedAt: now.toISOString(),
      },
    });
    if (cancelled) {
      cancelledFakeReminderItemIds.push(cancelled.id);
      await cancelItemReminderChains(params.userId, [cancelled.id]);
    }
  }

  return {
    ...preview,
    cancelledDuplicatePolicyIds,
    inferredBeforeEventPolicyIds,
    reviewRequiredPolicyIds,
    markedPastReviewItemIds,
    clearedReminderSessionActionIds,
    cancelledFakeReminderItemIds,
  };
}

export function collectV2180ProductionRepairCandidates(params: {
  items: PlannerItem[];
  policies: ReminderPolicy[];
  sessions: AgentAction[];
  now: Date;
}): V2180RepairCandidates {
  const itemsById = new Map(params.items.map((item) => [item.id, item]));
  return {
    duplicateBeforeEventPolicyIds: duplicateBeforeEventPolicyIds(params.policies, itemsById),
    genericBeforeEventPolicyIds: params.policies
      .filter((policy) => isGenericBeforeEventPolicy(policy, itemsById.get(policy.itemId ?? "")))
      .map((policy) => policy.id),
    pastImportantEventIds: params.items
      .filter((item) => isPastImportantEvent(item, params.now))
      .map((item) => item.id),
    staleReminderSessionActionIds: staleReminderSessionIds(params.sessions, params.now),
    fakeReminderItemIds: params.items.filter(isFakeStandaloneReminderItem).map((item) => item.id),
    calendarObjectsToChange: 0,
    safeToApply: true,
  };
}

async function loadData(userId: string) {
  return Promise.all([
    listManageableItems(userId, 500),
    listActiveReminderPolicies(userId, 500),
    listPendingAgentActionsByTypes({
      userId,
      actionTypes: STALE_SESSION_TYPES,
      limit: 100,
    }),
  ]);
}

function duplicateBeforeEventPolicyIds(
  policies: ReminderPolicy[],
  itemsById: Map<string, PlannerItem>,
) {
  const keepers = new Set<string>();
  const duplicates: string[] = [];
  for (const policy of policies) {
    if (!policy.itemId) continue;
    const item = itemsById.get(policy.itemId);
    const key = getBeforeEventPolicyKey(policy, item);
    if (!key) continue;
    const groupKey = `${policy.itemId}:${key}`;
    if (keepers.has(groupKey)) duplicates.push(policy.id);
    else keepers.add(groupKey);
  }
  return duplicates;
}

function isGenericBeforeEventPolicy(policy: ReminderPolicy, item?: PlannerItem) {
  if (!item || policy.metadata?.reviewRequired === true) return false;
  if (!["event", "training", "tentative_event"].includes(item.kind)) return false;
  if (policy.policyType === "before_event") {
    return !getBeforeEventPolicyKey(policy, item);
  }
  if (!["one_time", "custom"].includes(policy.policyType)) return false;
  if (policy.recurrenceRule || policy.intervalMinutes) return false;
  return !getEventLinkedReminderOffsetMinutes(policy, item);
}

function inferBeforeEventPolicy(policy: ReminderPolicy, item: PlannerItem) {
  const anchor = item.startAt ?? item.dueAt ?? null;
  const fireAt = policy.nextFireAt ?? policy.startsAt ?? null;
  if (!anchor || !fireAt) return null;
  const minutesBefore = Math.round((anchor.getTime() - fireAt.getTime()) / 60_000);
  if (!Number.isFinite(minutesBefore) || minutesBefore <= 0) return null;
  return { minutesBefore, fireAt };
}

function isPastImportantEvent(item: PlannerItem, now: Date) {
  if (!["event", "training", "tentative_event"].includes(item.kind)) return false;
  if (item.metadata?.pastReviewOverride && typeof item.metadata.pastReviewOverride === "object") {
    const override = item.metadata.pastReviewOverride as Record<string, unknown>;
    if (override.keepInPlan === true) return false;
  }
  if (typeof item.metadata?.pastReviewRequiredAt === "string") return false;
  const end = item.endAt ?? (item.startAt ? new Date(item.startAt.getTime() + 60 * 60_000) : null);
  if (!end || end > now) return false;
  return (
    item.priority >= 4 ||
    item.metadata?.important === true ||
    Number(item.metadata?.basePriority ?? 0) >= 4
  );
}

function staleReminderSessionIds(actions: AgentAction[], now: Date) {
  const ids = new Set<string>();
  const byTypeAndTarget = new Map<string, AgentAction[]>();
  for (const action of actions) {
    const expiresAt = parseDate(action.output?.expiresAt);
    if (expiresAt && expiresAt <= now) ids.add(action.id);
    const target = actionTargetId(action);
    const key = `${action.actionType}:${target ?? "none"}`;
    byTypeAndTarget.set(key, [...(byTypeAndTarget.get(key) ?? []), action]);
  }
  for (const group of byTypeAndTarget.values()) {
    if (group.length <= 1) continue;
    for (const stale of [...group]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(1)) {
      ids.add(stale.id);
    }
  }
  return [...ids];
}

function isFakeStandaloneReminderItem(item: PlannerItem) {
  if (!["event", "task", "tentative_event"].includes(item.kind)) return false;
  if (item.metadata?.archivedBy === "admin_repair_v2180") return false;
  const normalized = item.title.toLocaleLowerCase("ru").replace(/ё/g, "е");
  return (
    /напоминан|напомн/.test(normalized) &&
    /за\s+(?:день|пол\s*часа|полчаса|час|два\s+часа|2\s*часа|30\s*мин)/.test(normalized)
  );
}

function actionTargetId(action: AgentAction) {
  const output = action.output ?? {};
  return (
    stringValue(output.itemId) ??
    stringValue(output.activeEditItemId) ??
    stringValue(output.activeSessionTargetItemId) ??
    stringValue(output.sessionTargetItemId) ??
    null
  );
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
