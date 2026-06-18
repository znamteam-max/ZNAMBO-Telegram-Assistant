import { DateTime } from "luxon";

import { listPendingAgentActionsByTypes, updateAgentAction } from "@/db/queries/agentActions";
import {
  listManageableItems,
  listPinnedContextNotes,
  updatePlannerItemDetails,
} from "@/db/queries/items";
import { listActiveReminderPolicies, updateReminderPolicy } from "@/db/queries/reminderPolicies";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";
import { formatBeforeEventOffset } from "@/domain/reminderPolicyPresentation";
import { monthlyDayRangeAuditKey } from "@/services/reminderPolicyReconciler";

const TARGET_SESSION_TYPES = ["event_target_resolution", "reminder_target_resolution"];

export async function previewV2230ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const candidates = await collectV2230ProductionRepairCandidates(params);
  return {
    ...counts(candidates),
    ...candidates,
    calendarObjectsToChange: 0 as const,
    safeToApply: true as const,
    notes: [
      `technical before-event labels: ${candidates.technicalLabelPolicies.length}`,
      `stale target-resolution sessions: ${candidates.staleTargetResolutionSessions.length}`,
      `carryover candidates: ${candidates.carryoverCandidates.length}`,
      `monthly audit throttle init: ${candidates.monthlyPoliciesMissingThrottleKey.length}`,
      `pinned context notes: ${candidates.pinnedContextNotes}`,
      "V2.23 repair is calendar-safe; Yandex objects are not mutated",
    ],
  };
}

export async function applyV2230ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const candidates = await collectV2230ProductionRepairCandidates({ ...params, now });
  const relabeledPolicyIds: string[] = [];
  const clearedSessionActionIds: string[] = [];
  const carryoverMarkedItemIds: string[] = [];
  const initializedMonthlyThrottlePolicyIds: string[] = [];

  for (const policy of candidates.technicalLabelPolicies) {
    const minutesBefore = Number(policy.metadata?.minutesBefore);
    if (!Number.isFinite(minutesBefore) || minutesBefore <= 0) continue;
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      metadata: {
        relativeLabel: formatBeforeEventOffset(minutesBefore),
        relabeledBy: "admin_repair_v2230",
        relabeledAt: now.toISOString(),
      },
    });
    if (updated) relabeledPolicyIds.push(updated.id);
  }

  for (const session of candidates.staleTargetResolutionSessions) {
    const updated = await updateAgentAction({
      userId: params.userId,
      actionId: session.id,
      status: "cancelled",
      output: {
        ...(session.output ?? {}),
        cancelledBy: "admin_repair_v2230",
        cancelledAt: now.toISOString(),
        cancelledReason: "stale_target_resolution_can_hijack_new_creation_intent",
      },
    });
    if (updated) clearedSessionActionIds.push(updated.id);
  }

  for (const item of candidates.carryoverCandidates) {
    const anchor = item.dueAt ?? item.startAt;
    const updated = await updatePlannerItemDetails({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        untilDoneCarryover: true,
        originalDueAt: anchor?.toISOString() ?? null,
        carryoverMarkedAt: now.toISOString(),
        carryoverMarkedBy: "admin_repair_v2230",
      },
    });
    if (updated) carryoverMarkedItemIds.push(updated.id);
  }

  for (const policy of candidates.monthlyPoliciesMissingThrottleKey) {
    const scheduledFor = policy.nextFireAt ?? now;
    const auditKey = monthlyDayRangeAuditKey(policy.id, scheduledFor);
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      metadata: {
        lastMonthlyDayRangeCheckedAuditKey: auditKey,
        lastMonthlyDayRangeCheckedAt: now.toISOString(),
        initializedBy: "admin_repair_v2230",
      },
    });
    if (updated) initializedMonthlyThrottlePolicyIds.push(updated.id);
  }

  return {
    ...counts(candidates),
    ...candidates,
    relabeledPolicyIds,
    clearedSessionActionIds,
    carryoverMarkedItemIds,
    initializedMonthlyThrottlePolicyIds,
    calendarObjectsChanged: 0 as const,
    calendarObjectsToChange: 0 as const,
    safeToApply: true as const,
  };
}

async function collectV2230ProductionRepairCandidates(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const [policies, sessions, items, pinnedNotes] = await Promise.all([
    listActiveReminderPolicies(params.userId, 500),
    listPendingAgentActionsByTypes({
      userId: params.userId,
      actionTypes: TARGET_SESSION_TYPES,
      limit: 200,
    }),
    listManageableItems(params.userId, 500),
    listPinnedContextNotes(params.userId, 100),
  ]);
  const technicalLabelPolicies = policies.filter(isTechnicalBeforeEventPolicy);
  const staleTargetResolutionSessions = sessions.filter((session) => isStaleSession(session, now));
  const carryoverCandidates = items.filter((item) => isCarryoverCandidate(item, now, params.timezone));
  const monthlyPoliciesMissingThrottleKey = policies.filter(
    (policy) =>
      /^monthly_days:/i.test(policy.recurrenceRule ?? "") &&
      !policy.metadata?.lastMonthlyDayRangeCheckedAuditKey,
  );
  const pinnedContextNotes = pinnedNotes.length;

  return {
    technicalLabelPolicies,
    technicalLabelPolicyIds: technicalLabelPolicies.map((policy) => policy.id),
    staleTargetResolutionSessions,
    staleTargetResolutionSessionIds: staleTargetResolutionSessions.map((session) => session.id),
    carryoverCandidates,
    carryoverCandidateItemIds: carryoverCandidates.map((item) => item.id),
    monthlyPoliciesMissingThrottleKey,
    monthlyPolicyIdsMissingThrottleKey: monthlyPoliciesMissingThrottleKey.map((policy) => policy.id),
    pinnedContextNotes,
  };
}

function counts(candidates: Awaited<ReturnType<typeof collectV2230ProductionRepairCandidates>>) {
  return {
    technicalBeforeEventLabels: candidates.technicalLabelPolicies.length,
    staleTargetResolutionSessions: candidates.staleTargetResolutionSessions.length,
    carryoverCandidates: candidates.carryoverCandidates.length,
    monthlyAuditThrottleInitializations: candidates.monthlyPoliciesMissingThrottleKey.length,
    pinnedContextNotes: candidates.pinnedContextNotes,
  };
}

function isTechnicalBeforeEventPolicy(policy: ReminderPolicy) {
  if (policy.policyType !== "before_event") return false;
  const label = typeof policy.metadata?.relativeLabel === "string" ? policy.metadata.relativeLabel : "";
  if (!label) return false;
  return /(?:\b\d+\s*ч\b|\b\d+\s*минут\b|\b\d+\s*minutes?\b|\b\d+\s*hours?\b)/i.test(label);
}

function isStaleSession(action: AgentAction, now: Date) {
  const expiresAt =
    typeof action.output?.expiresAt === "string" ? new Date(action.output.expiresAt) : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime())) return expiresAt <= now;
  return now.getTime() - action.createdAt.getTime() > 30 * 60_000;
}

function isCarryoverCandidate(item: PlannerItem, now: Date, timezone: string) {
  if (item.status !== "active") return false;
  if (item.metadata?.untilDoneCarryover === true) return false;
  if (!["task", "preparation_task"].includes(item.kind)) return false;
  if (item.metadata?.untilDone !== true && item.metadata?.timeScope !== "today") return false;
  const anchor = item.dueAt ?? item.startAt;
  if (!anchor || anchor >= now) return false;
  const localNow = DateTime.fromJSDate(now, { zone: "utc" }).setZone(item.timezone || timezone);
  const localAnchor = DateTime.fromJSDate(anchor, { zone: "utc" }).setZone(item.timezone || timezone);
  return localAnchor < localNow.startOf("day");
}
