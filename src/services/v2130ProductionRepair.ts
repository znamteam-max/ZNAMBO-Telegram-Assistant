import { writeAudit } from "@/db/queries/audit";
import { listPendingAgentActionsByTypes, updateAgentAction } from "@/db/queries/agentActions";
import {
  cancelPlannerItemWithMetadata,
  listManageableItems,
  updatePlannerItemDetails,
} from "@/db/queries/items";
import {
  listActiveReminderPolicies,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelPendingRemindersForPolicy } from "@/db/queries/reminders";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";
import { parseCanonicalRecurrenceRule } from "@/domain/recurringPolicySemantics";

const SESSION_ACTION_TYPES = [
  "item_edit_session",
  "reminder_policy_edit_session",
  "recurring_policy_draft",
  "external_calendar_edit_session",
];

export async function previewV2130ProductionRepair(params: { userId: string; now?: Date }) {
  const [items, policies, pendingSessions] = await loadRepairData(params.userId);
  const incompleteMeterItems = items.filter((item) =>
    isIncompleteMeterReadingItem(item, policies),
  );
  const incompleteMeterPolicies = policies.filter(isIncompleteMeterReadingPolicy);
  const recurringDrafts = pendingSessions.filter(
    (action) => action.actionType === "recurring_policy_draft",
  );
  const duplicateDraftIds = duplicateDrafts(recurringDrafts).map((action) => action.id);
  const staleSessionIds = pendingSessions.map((action) => action.id);
  const orthodontistItem = items.find(isOrthodontistScheduledItem) ?? null;
  const orthodontistNeedsEventKind = Boolean(
    orthodontistItem && orthodontistItem.kind !== "event",
  );
  const orphanOrthodontistPolicyIds = orthodontistItem
    ? policies.filter((policy) => isOrthodontistPolicy(policy) && policy.itemId !== orthodontistItem.id).map((policy) => policy.id)
    : [];

  return {
    incompleteMeterItemIds: incompleteMeterItems.map((item) => item.id),
    incompleteMeterPolicyIds: incompleteMeterPolicies.map((policy) => policy.id),
    duplicateRecurringDraftIds: duplicateDraftIds,
    staleSessionIds,
    orthodontistItemId: orthodontistItem?.id ?? null,
    orthodontistNeedsEventKind,
    orphanOrthodontistPolicyIds,
    calendarObjectsToChange: 0,
    safeToApply: true,
    notes: [
      `incomplete meter items: ${incompleteMeterItems.length}`,
      `incomplete meter policies: ${incompleteMeterPolicies.length}`,
      `duplicate recurring drafts: ${duplicateDraftIds.length}`,
      `pending sessions to clear: ${staleSessionIds.length}`,
      orthodontistNeedsEventKind
        ? "orthodontist scheduled item will be classified as event"
        : "orthodontist scheduled item already ok or absent",
      "Yandex Calendar objects will not be changed",
    ],
  };
}

export async function applyV2130ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const preview = await previewV2130ProductionRepair({ ...params, now });
  const [items, policies, pendingSessions] = await loadRepairData(params.userId);
  const archivedItemIds: string[] = [];
  const cancelledPolicyIds: string[] = [];
  const clearedDraftIds: string[] = [];
  const clearedSessionIds: string[] = [];
  const normalizedItemIds: string[] = [];
  const retargetedPolicyIds: string[] = [];

  for (const item of items.filter((candidate) => preview.incompleteMeterItemIds.includes(candidate.id))) {
    const archived = await cancelPlannerItemWithMetadata({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        archivedBy: "admin_repair_v2130",
        repairVersion: "2.13.0",
        archiveReason: "incomplete_recurring_meter_draft_leak",
        archivedAt: now.toISOString(),
      },
    });
    if (archived) archivedItemIds.push(archived.id);
  }

  for (const policy of policies.filter((candidate) =>
    preview.incompleteMeterPolicyIds.includes(candidate.id),
  )) {
    await cancelPendingRemindersForPolicy({ userId: params.userId, policyId: policy.id });
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      status: "cancelled",
      nextFireAt: null,
      metadata: {
        cancelledBy: "admin_repair_v2130",
        repairVersion: "2.13.0",
        cancelReason: "incomplete_recurring_meter_policy",
        cancelledAt: now.toISOString(),
      },
    });
    if (updated) cancelledPolicyIds.push(updated.id);
  }

  const orthodontistItem = items.find(isOrthodontistScheduledItem) ?? null;
  if (orthodontistItem && orthodontistItem.kind !== "event") {
    const updated = await updatePlannerItemDetails({
      userId: params.userId,
      itemId: orthodontistItem.id,
      kind: "event",
      category: orthodontistItem.category ?? "health",
      visibility: "active",
      metadata: {
        repairedBy: "admin_repair_v2130",
        repairVersion: "2.13.0",
        previousKind: orthodontistItem.kind,
        repairedAt: now.toISOString(),
      },
    });
    if (updated) normalizedItemIds.push(updated.id);
  }

  if (orthodontistItem) {
    for (const policy of policies.filter(
      (candidate) => isOrthodontistPolicy(candidate) && candidate.itemId !== orthodontistItem.id,
    )) {
      const updated = await updateReminderPolicy({
        userId: params.userId,
        policyId: policy.id,
        itemId: orthodontistItem.id,
        title: orthodontistItem.title,
        category: orthodontistItem.category ?? policy.category,
        metadata: {
          retargetedBy: "admin_repair_v2130",
          repairVersion: "2.13.0",
          previousItemId: policy.itemId,
          retargetedAt: now.toISOString(),
        },
      });
      if (updated) retargetedPolicyIds.push(updated.id);
    }
  }

  for (const action of pendingSessions.filter((candidate) =>
    preview.staleSessionIds.includes(candidate.id),
  )) {
    const updated = await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...(action.output ?? {}),
        cancelledReason:
          action.actionType === "recurring_policy_draft"
            ? "admin_repair_v2130_clear_recurring_draft"
            : "admin_repair_v2130_stale_session",
        cancelledAt: now.toISOString(),
        repairVersion: "2.13.0",
      },
    });
    if (updated) {
      clearedSessionIds.push(updated.id);
      if (action.actionType === "recurring_policy_draft") clearedDraftIds.push(updated.id);
    }
  }

  await writeAudit({
    userId: params.userId,
    action: "assistant.v2130_production_repair",
    entityType: "production_repair",
    details: {
      repairVersion: "2.13.0",
      archivedItemIds,
      cancelledPolicyIds,
      clearedDraftIds,
      clearedSessionIds,
      normalizedItemIds,
      retargetedPolicyIds,
      calendarObjectsChanged: 0,
    },
  }).catch(() => undefined);

  return {
    preview,
    archivedItemIds,
    cancelledPolicyIds,
    clearedDraftIds,
    clearedSessionIds,
    normalizedItemIds,
    retargetedPolicyIds,
    calendarObjectsChanged: 0,
  };
}

async function loadRepairData(userId: string) {
  return Promise.all([
    listManageableItems(userId, 600),
    listActiveReminderPolicies(userId, 600),
    listPendingAgentActionsByTypes({
      userId,
      actionTypes: SESSION_ACTION_TYPES,
      limit: 200,
    }),
  ]);
}

function isIncompleteMeterReadingItem(item: PlannerItem, policies: ReminderPolicy[]) {
  if (!isMeterReadingTitle(item.title)) return false;
  if (item.kind !== "recurring_task") return false;
  const hasCompletePolicy = policies.some(
    (policy) =>
      policy.itemId === item.id &&
      isMeterReadingTitle(policy.title) &&
      !isIncompleteMeterReadingPolicy(policy),
  );
  return (
    item.metadata?.timeUnspecified === true ||
    item.metadata?.recurringPolicyMissingTime === true ||
    (!item.startAt && !item.dueAt && !hasCompletePolicy)
  );
}

function isIncompleteMeterReadingPolicy(policy: ReminderPolicy) {
  if (!isMeterReadingTitle(policy.title)) return false;
  if (!["recurring", "long_term"].includes(policy.policyType)) return false;
  const parsed = parseCanonicalRecurrenceRule(policy.recurrenceRule);
  return Boolean(parsed && parsed.kind !== "legacy" && !parsed.timeLocal) || !policy.nextFireAt;
}

function duplicateDrafts(actions: AgentAction[]) {
  const byFingerprint = new Map<string, AgentAction[]>();
  for (const action of actions) {
    const fingerprint =
      typeof action.output?.draftFingerprint === "string"
        ? action.output.draftFingerprint
        : JSON.stringify({
            plan: action.output?.plan ?? null,
            policies: action.output?.policies ?? null,
          });
    byFingerprint.set(fingerprint, [...(byFingerprint.get(fingerprint) ?? []), action]);
  }
  return [...byFingerprint.values()].flatMap((group) =>
    group
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(1),
  );
}

function isOrthodontistScheduledItem(item: PlannerItem) {
  return isOrthodontistTitle(item.title) && Boolean(item.startAt || item.dueAt);
}

function isOrthodontistPolicy(policy: ReminderPolicy) {
  return isOrthodontistTitle(policy.title);
}

function isMeterReadingTitle(title: string) {
  const normalized = normalize(title);
  return (
    normalized.includes("показан") &&
    (normalized.includes("счетчик") || normalized.includes("счётчик")) &&
    normalized.includes("квартир")
  );
}

function isOrthodontistTitle(title: string) {
  const normalized = normalize(title);
  return normalized.includes("ортодонт") || normalized.includes("ортодон");
}

function normalize(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
