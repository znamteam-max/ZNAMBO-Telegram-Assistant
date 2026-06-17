import { listManageableItems, updatePlannerItemDetails } from "@/db/queries/items";
import {
  attachOccurrenceReminder,
  getPendingReminderForPolicy,
  listActiveReminderPolicies,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelPendingRemindersForPolicy, createReminderIfMissing } from "@/db/queries/reminders";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { resolvePolicyReconcileTarget } from "@/domain/reminderPolicySchedule";
import {
  isTodayUntilDoneReminderPolicy,
  todayUntilDoneMetadataFromPolicy,
} from "@/domain/todayUntilDoneTask";

import { materializeNextPolicyReminder } from "./reminderPolicyEngine";

export type V2190RepairCandidates = {
  policiesMissingNextReminderIds: string[];
  repairablePolicyIds: string[];
  expiredPolicyIds: string[];
  reviewRequiredPolicyIds: string[];
  todayUntilDoneItemIdsMissingDueAt: string[];
  calendarObjectsToChange: 0;
  safeToApply: true;
};

export async function previewV2190ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const [items, policies, pendingPolicyIds] = await loadData(params.userId);
  const candidates = collectV2190ProductionRepairCandidates({
    items,
    policies,
    pendingPolicyIds,
    now,
    timezone: params.timezone,
  });
  return {
    ...candidates,
    policiesMissingNextReminder: candidates.policiesMissingNextReminderIds.length,
    repairablePolicies: candidates.repairablePolicyIds.length,
    expiredPolicies: candidates.expiredPolicyIds.length,
    reviewRequiredPolicies: candidates.reviewRequiredPolicyIds.length,
    todayUntilDoneItemsMissingDueAt: candidates.todayUntilDoneItemIdsMissingDueAt.length,
    notes: [
      `policies missing next reminder: ${candidates.policiesMissingNextReminderIds.length}`,
      `repairable policies: ${candidates.repairablePolicyIds.length}`,
      `expired policies: ${candidates.expiredPolicyIds.length}`,
      `review-required policies: ${candidates.reviewRequiredPolicyIds.length}`,
      `today until-done items missing dueAt: ${candidates.todayUntilDoneItemIdsMissingDueAt.length}`,
      "Yandex Calendar objects will not be changed",
    ],
  };
}

export async function applyV2190ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const preview = await previewV2190ProductionRepair(params);
  const [items, policies] = await Promise.all([
    listManageableItems(params.userId, 500),
    listActiveReminderPolicies(params.userId, 500),
  ]);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const materializedPolicyIds: string[] = [];
  const expiredPolicyIds: string[] = [];
  const reviewMarkedPolicyIds: string[] = [];
  const repairedTodayDueItemIds: string[] = [];

  for (const policy of policies.filter((candidate) =>
    preview.todayUntilDoneItemIdsMissingDueAt.includes(candidate.itemId ?? ""),
  )) {
    if (!policy.itemId || !policy.endsAt) continue;
    const item = itemsById.get(policy.itemId);
    if (!item || item.dueAt || item.startAt) continue;
    const updated = await updatePlannerItemDetails({
      userId: params.userId,
      itemId: item.id,
      dueAt: policy.endsAt,
      visibility: "active",
      metadata: {
        ...todayUntilDoneMetadataFromPolicy(policy),
        repairedBy: "admin_repair_v2190",
        repairedAt: now.toISOString(),
        repairReason: "today_until_done_missing_item_due_at",
      },
    });
    if (updated) repairedTodayDueItemIds.push(updated.id);
  }

  for (const policy of policies.filter((candidate) =>
    preview.expiredPolicyIds.includes(candidate.id),
  )) {
    await cancelPendingRemindersForPolicy({
      userId: params.userId,
      policyId: policy.id,
      from: new Date(0),
    });
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      status: "expired",
      nextFireAt: null,
      metadata: {
        repairedBy: "admin_repair_v2190",
        repairedAt: now.toISOString(),
        repairReason: "policy_window_already_ended",
      },
    });
    if (updated) expiredPolicyIds.push(updated.id);
  }

  for (const policy of policies.filter((candidate) =>
    preview.reviewRequiredPolicyIds.includes(candidate.id),
  )) {
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      status: "cancelled",
      nextFireAt: null,
      metadata: {
        repairedBy: "admin_repair_v2190",
        repairedAt: now.toISOString(),
        repairReason: "missing_next_reminder_unresolvable",
        reviewRequired: true,
      },
    });
    if (updated) reviewMarkedPolicyIds.push(updated.id);
  }

  for (const policy of policies.filter((candidate) =>
    preview.repairablePolicyIds.includes(candidate.id),
  )) {
    const target = resolvePolicyReconcileTarget(policy, now);
    if (!target) continue;
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      nextFireAt: target.scheduledFor,
      status: "active",
      metadata: {
        repairedBy: "admin_repair_v2190",
        repairedAt: now.toISOString(),
        repairReason: "missing_next_reminder_materialized",
        catchUpScheduledFor: target.catchUp ? target.scheduledFor.toISOString() : null,
      },
    });
    const reminder = updated
      ? await materializeNextPolicyReminder(updated, target.scheduledFor, {
          now,
          deliveryAt: target.deliveryAt,
          catchUp: target.catchUp,
        })
      : null;
    const repairedReminder =
      reminder ??
      (updated
        ? await createReplacementPolicyReminder({
            policy: updated,
            scheduledFor: target.scheduledFor,
            deliveryAt: target.deliveryAt,
            repairStartedAt: now,
          })
        : null);
    if (repairedReminder) materializedPolicyIds.push(policy.id);
  }

  return {
    ...preview,
    materializedPolicyIds,
    expiredPolicyIds,
    reviewMarkedPolicyIds,
    repairedTodayDueItemIds,
  };
}

export function collectV2190ProductionRepairCandidates(params: {
  items: PlannerItem[];
  policies: ReminderPolicy[];
  pendingPolicyIds: Set<string>;
  now: Date;
  timezone: string;
}): V2190RepairCandidates {
  const itemsById = new Map(params.items.map((item) => [item.id, item]));
  const policiesMissingNextReminderIds: string[] = [];
  const repairablePolicyIds: string[] = [];
  const expiredPolicyIds: string[] = [];
  const reviewRequiredPolicyIds: string[] = [];
  const todayUntilDoneItemIdsMissingDueAt = new Set<string>();

  for (const policy of params.policies) {
    if (policy.status !== "active") continue;
    const item = policy.itemId ? itemsById.get(policy.itemId) : null;
    if (item && !item.startAt && !item.dueAt && isTodayUntilDoneReminderPolicy(policy)) {
      todayUntilDoneItemIdsMissingDueAt.add(item.id);
    }

    const missingNextReminder = !policy.nextFireAt || !params.pendingPolicyIds.has(policy.id);
    if (!missingNextReminder) continue;
    policiesMissingNextReminderIds.push(policy.id);
    if (policy.endsAt && policy.endsAt < params.now && policy.onWindowEnd !== "carry_to_next_day") {
      expiredPolicyIds.push(policy.id);
      continue;
    }
    if (resolvePolicyReconcileTarget(policy, params.now)) {
      repairablePolicyIds.push(policy.id);
      continue;
    }
    reviewRequiredPolicyIds.push(policy.id);
  }

  return {
    policiesMissingNextReminderIds,
    repairablePolicyIds,
    expiredPolicyIds,
    reviewRequiredPolicyIds,
    todayUntilDoneItemIdsMissingDueAt: [...todayUntilDoneItemIdsMissingDueAt],
    calendarObjectsToChange: 0,
    safeToApply: true,
  };
}

async function loadData(userId: string) {
  const [items, policies] = await Promise.all([
    listManageableItems(userId, 500),
    listActiveReminderPolicies(userId, 500),
  ]);
  const pendingPolicyIds = new Set<string>();
  for (const policy of policies) {
    const pending = await getPendingReminderForPolicy(policy.id);
    if (pending) pendingPolicyIds.add(policy.id);
  }
  return [items, policies, pendingPolicyIds] as const;
}

async function createReplacementPolicyReminder(params: {
  policy: ReminderPolicy;
  scheduledFor: Date;
  deliveryAt: Date;
  repairStartedAt: Date;
}) {
  const reminder = await createReminderIfMissing({
    userId: params.policy.userId,
    plannerItemId: params.policy.itemId,
    type: reminderTypeForPolicy(params.policy),
    idempotencyKey: [
      "policy",
      params.policy.id,
      params.scheduledFor.toISOString(),
      "v2190-repair",
      params.repairStartedAt.toISOString(),
    ].join(":"),
    scheduledAt: params.deliveryAt,
    spacingLatestAt: ["interval_window", "nag_until_ack"].includes(params.policy.policyType)
      ? params.policy.endsAt
      : null,
    repeatUntilAck: params.policy.requireAck,
    recurrenceKey: params.policy.recurrenceRule,
    policyId: params.policy.id,
    purpose: purposeForPolicy(params.policy),
    menuType: ["after_event", "post_event_menu"].includes(params.policy.policyType)
      ? "event_reaction"
      : "reminder",
    payload: {
      title: params.policy.title,
      policyType: params.policy.policyType,
      category: params.policy.category,
      requireAck: params.policy.requireAck,
      scheduledFor: params.scheduledFor.toISOString(),
      repairedBy: "admin_repair_v2190",
    },
  });
  if (reminder) {
    await attachOccurrenceReminder({
      policyId: params.policy.id,
      scheduledFor: params.scheduledFor,
      reminderId: reminder.id,
    });
  }
  return reminder;
}

function reminderTypeForPolicy(policy: ReminderPolicy) {
  if (policy.policyType === "before_event") return "event_before";
  if (["after_event", "post_event_menu"].includes(policy.policyType)) return "after_event";
  if (policy.policyType === "recurring" || policy.policyType === "long_term") return "recurring";
  if (policy.policyType === "nag_until_ack") return "until_ack";
  return "custom";
}

function purposeForPolicy(policy: ReminderPolicy) {
  if (policy.policyType === "before_event") return "pre_event";
  if (["after_event", "post_event_menu"].includes(policy.policyType)) return "post_event_menu";
  if (policy.policyType === "interval_window") return "interval_nag";
  if (policy.policyType === "recurring" || policy.policyType === "long_term") {
    return "recurring_check";
  }
  return "reminder";
}
