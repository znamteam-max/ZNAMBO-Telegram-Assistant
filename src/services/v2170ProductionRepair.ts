import { cancelPendingRemindersForPolicy } from "@/db/queries/reminders";
import { listManageableItems, mergePlannerItemMetadata } from "@/db/queries/items";
import {
  listActiveReminderPolicies,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { listPendingAgentActionsByTypes, updateAgentAction } from "@/db/queries/agentActions";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";
import { getBeforeEventPolicyKey } from "@/domain/reminderPolicyPresentation";

export async function previewV2170ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const [items, policies, sessions] = await loadData(params.userId);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const duplicateBeforeEventPolicyIds = duplicateBeforeEventPolicies(policies, itemsById);
  const genericBeforeEventPolicyIds = policies
    .filter((policy) => policy.policyType === "before_event")
    .filter((policy) => !getBeforeEventPolicyKey(policy, itemsById.get(policy.itemId ?? "")))
    .map((policy) => policy.id);
  const pastReviewItemIds = items.filter((item) => isPastImportantEvent(item, now)).map((item) => item.id);
  const staleTargetResolutionActionIds = staleTargetResolutionIds(sessions, now);

  return {
    duplicateBeforeEventPolicyIds,
    genericBeforeEventPolicyIds,
    pastReviewItemIds,
    staleTargetResolutionActionIds,
    contradictoryTraceIds: [] as string[],
    calendarObjectsToChange: 0,
    safeToApply: true,
    notes: [
      `duplicate before-event offsets: ${duplicateBeforeEventPolicyIds.length}`,
      `before-event policies needing review: ${genericBeforeEventPolicyIds.length}`,
      `past important event review items: ${pastReviewItemIds.length}`,
      `stale target-resolution sessions: ${staleTargetResolutionActionIds.length}`,
      "Yandex Calendar objects will not be changed",
    ],
  };
}

export async function applyV2170ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const preview = await previewV2170ProductionRepair({ ...params, now });
  const [items, policies, sessions] = await loadData(params.userId);
  const cancelledDuplicatePolicyIds: string[] = [];
  const reviewRequiredPolicyIds: string[] = [];
  const markedPastReviewItemIds: string[] = [];
  const clearedTargetResolutionActionIds: string[] = [];

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
        repairedBy: "admin_repair_v2170",
        repairReason: "duplicate_before_event_offset",
        repairedAt: now.toISOString(),
      },
    });
    if (updated) cancelledDuplicatePolicyIds.push(updated.id);
  }

  for (const policy of policies.filter((candidate) =>
    preview.genericBeforeEventPolicyIds.includes(candidate.id),
  )) {
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      metadata: {
        repairedBy: "admin_repair_v2170",
        reviewRequired: true,
        reviewReason: "before_event_offset_not_inferable",
        reviewedAt: null,
      },
    });
    if (updated) reviewRequiredPolicyIds.push(updated.id);
  }

  for (const item of items.filter((candidate) => preview.pastReviewItemIds.includes(candidate.id))) {
    const updated = await mergePlannerItemMetadata({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        pastReviewRequiredAt: now.toISOString(),
        pastReviewReason: "ended_important_event",
        repairedBy: "admin_repair_v2170",
      },
    });
    if (updated) markedPastReviewItemIds.push(updated.id);
  }

  for (const action of sessions.filter((candidate) =>
    preview.staleTargetResolutionActionIds.includes(candidate.id),
  )) {
    const updated = await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...(action.output ?? {}),
        cancelledReason: "admin_repair_v2170_stale_target_resolution",
        cancelledAt: now.toISOString(),
      },
    });
    if (updated) clearedTargetResolutionActionIds.push(updated.id);
  }

  return {
    ...preview,
    cancelledDuplicatePolicyIds,
    reviewRequiredPolicyIds,
    markedPastReviewItemIds,
    clearedTargetResolutionActionIds,
  };
}

async function loadData(userId: string) {
  return Promise.all([
    listManageableItems(userId, 500),
    listActiveReminderPolicies(userId, 500),
    listPendingAgentActionsByTypes({
      userId,
      actionTypes: ["event_target_resolution", "reminder_target_resolution"],
      limit: 100,
    }),
  ]);
}

function duplicateBeforeEventPolicies(
  policies: ReminderPolicy[],
  itemsById: Map<string, PlannerItem>,
) {
  const keepers = new Set<string>();
  const duplicates: string[] = [];
  for (const policy of policies) {
    if (policy.policyType !== "before_event" || !policy.itemId) continue;
    const item = itemsById.get(policy.itemId);
    const key = getBeforeEventPolicyKey(policy, item);
    if (!key) continue;
    const groupKey = `${policy.itemId}:${key}`;
    if (keepers.has(groupKey)) {
      duplicates.push(policy.id);
    } else {
      keepers.add(groupKey);
    }
  }
  return duplicates;
}

function isPastImportantEvent(item: PlannerItem, now: Date) {
  if (!["event", "training", "tentative_event"].includes(item.kind)) return false;
  if (item.metadata?.pastReviewOverride && typeof item.metadata.pastReviewOverride === "object") {
    const override = item.metadata.pastReviewOverride as Record<string, unknown>;
    if (override.keepInPlan === true) return false;
  }
  const end = item.endAt ?? (item.startAt ? new Date(item.startAt.getTime() + 60 * 60_000) : null);
  if (!end || end > now) return false;
  return (
    item.priority >= 4 ||
    item.metadata?.important === true ||
    Number(item.metadata?.basePriority ?? 0) >= 4
  );
}

function staleTargetResolutionIds(actions: AgentAction[], now: Date) {
  return actions
    .filter((action) => {
      const expiresAt = parseDate(action.output?.expiresAt);
      return expiresAt ? expiresAt <= now : false;
    })
    .map((action) => action.id);
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
