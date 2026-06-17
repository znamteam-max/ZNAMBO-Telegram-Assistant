import { sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { listPendingAgentActionsByTypes, updateAgentAction } from "@/db/queries/agentActions";
import { listManageableItems, updatePlannerItemDetails } from "@/db/queries/items";
import { listActiveReminderPolicies, updateReminderPolicy } from "@/db/queries/reminderPolicies";
import type { AgentAction, ReminderPolicy } from "@/db/schema";
import { nextGridSlot } from "@/domain/reminderPolicySchedule";

const SESSION_TYPES = [
  "item_edit_session",
  "multi_reminder_setup_session",
  "reminder_policy_edit_session",
  "recurring_policy_draft",
  "external_calendar_edit_session",
];

export async function previewV2220ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const candidates = await collectV2220ProductionRepairCandidates(params);
  return {
    ...counts(candidates),
    ...candidates,
    calendarObjectsToChange: 0 as const,
    safeToApply: true as const,
    notes: [
      `stale sessions: ${candidates.staleSessionActionIds.length}`,
      `interval policies attached to wrong item: ${candidates.intervalPolicyIdsAttachedToWrongItem.length}`,
      `interval-window items missing finite window fields: ${candidates.intervalWindowItemIdsMissingWindowFields.length}`,
      `finite-window policies with next outside window: ${candidates.finiteWindowPolicyNextOutsideWindowIds.length}`,
      `duplicate dense reminder windows: ${candidates.duplicateDenseReminderPolicyIds.length}`,
      "V2.22 repair is calendar-safe; Yandex objects are not mutated",
    ],
  };
}

export async function applyV2220ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const candidates = await collectV2220ProductionRepairCandidates({ ...params, now });
  const clearedSessionActionIds: string[] = [];
  const repairedItemIds: string[] = [];
  const repairedPolicyIds: string[] = [];

  for (const actionId of candidates.staleSessionActionIds) {
    const updated = await updateAgentAction({
      userId: params.userId,
      actionId,
      status: "cancelled",
      output: {
        cancelledBy: "admin_repair_v2220",
        cancelledAt: now.toISOString(),
        cancelledReason: "stale_session_can_hijack_new_intent",
      },
    });
    if (updated) clearedSessionActionIds.push(updated.id);
  }

  for (const candidate of candidates.intervalWindowItemRepairCandidates) {
    const updated = await updatePlannerItemDetails({
      userId: params.userId,
      itemId: candidate.itemId,
      kind: "task",
      startAt: candidate.startsAt,
      dueAt: candidate.endsAt,
      visibility: "active",
      metadata: {
        repairedBy: "admin_repair_v2220",
        repairedAt: now.toISOString(),
        repairReason: "interval_window_item_missing_window_fields",
        intervalWindowReminder: true,
      },
    });
    if (updated) repairedItemIds.push(updated.id);
  }

  for (const policy of candidates.finiteWindowPolicyNextOutsideWindowPolicies) {
    const next = nextFinitePolicySlot(policy, now);
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      nextFireAt: next,
      status: next ? "active" : "expired",
      metadata: {
        repairedBy: "admin_repair_v2220",
        repairedAt: now.toISOString(),
        repairReason: "finite_window_next_fire_outside_window",
      },
    });
    if (updated) repairedPolicyIds.push(updated.id);
  }

  return {
    ...counts(candidates),
    ...candidates,
    clearedSessionActionIds,
    repairedItemIds,
    repairedPolicyIds,
    calendarObjectsChanged: 0 as const,
    calendarObjectsToChange: 0 as const,
    safeToApply: true as const,
  };
}

async function collectV2220ProductionRepairCandidates(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const [sessions, policies, items, duplicateDenseReminderPolicyIds] = await Promise.all([
    listPendingAgentActionsByTypes({
      userId: params.userId,
      actionTypes: SESSION_TYPES,
      limit: 200,
    }),
    listActiveReminderPolicies(params.userId, 500),
    listManageableItems(params.userId, 500),
    listDuplicateDenseReminderPolicyIds(params.userId),
  ]);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const staleSessions = sessions.filter((action) => isStaleSession(action, now));
  const intervalPolicies = policies.filter((policy) => policy.policyType === "interval_window");
  const intervalPolicyIdsAttachedToWrongItem = intervalPolicies
    .filter((policy) => {
      const item = policy.itemId ? itemById.get(policy.itemId) : null;
      return Boolean(item && item.kind === "recurring_task");
    })
    .map((policy) => policy.id);
  const intervalWindowItemRepairCandidates = intervalPolicies
    .map((policy) => {
      const item = policy.itemId ? itemById.get(policy.itemId) : null;
      if (!item || !policy.startsAt || !policy.endsAt) return null;
      if (
        item.visibility === "long_term" ||
        item.kind === "recurring_task" ||
        !item.startAt ||
        !item.dueAt
      ) {
        return {
          itemId: item.id,
          policyId: policy.id,
          startsAt: policy.startsAt,
          endsAt: policy.endsAt,
        };
      }
      return null;
    })
    .filter((candidate): candidate is {
      itemId: string;
      policyId: string;
      startsAt: Date;
      endsAt: Date;
    } => Boolean(candidate));
  const finiteWindowPolicyNextOutsideWindowPolicies = policies.filter(
    (policy) =>
      ["interval_window", "nag_until_ack"].includes(policy.policyType) &&
      Boolean(policy.endsAt && policy.nextFireAt && policy.nextFireAt > policy.endsAt),
  );
  return {
    staleSessionActionIds: staleSessions.map((action) => action.id),
    staleSessionTypes: staleSessions.map((action) => action.actionType),
    intervalPolicyIdsAttachedToWrongItem,
    intervalWindowItemIdsMissingWindowFields: intervalWindowItemRepairCandidates.map(
      (candidate) => candidate.itemId,
    ),
    intervalWindowItemRepairCandidates,
    finiteWindowPolicyNextOutsideWindowIds: finiteWindowPolicyNextOutsideWindowPolicies.map(
      (policy) => policy.id,
    ),
    finiteWindowPolicyNextOutsideWindowPolicies,
    duplicateDenseReminderPolicyIds,
  };
}

function counts(candidates: Awaited<ReturnType<typeof collectV2220ProductionRepairCandidates>>) {
  return {
    staleSessions: candidates.staleSessionActionIds.length,
    intervalPoliciesAttachedToWrongItem: candidates.intervalPolicyIdsAttachedToWrongItem.length,
    intervalWindowItemsMissingWindowFields:
      candidates.intervalWindowItemIdsMissingWindowFields.length,
    finiteWindowPoliciesNextOutsideWindow:
      candidates.finiteWindowPolicyNextOutsideWindowIds.length,
    duplicateDenseReminderWindows: candidates.duplicateDenseReminderPolicyIds.length,
  };
}

function isStaleSession(action: AgentAction, now: Date) {
  const expiresAt =
    typeof action.output?.expiresAt === "string" ? new Date(action.output.expiresAt) : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime())) return expiresAt <= now;
  return now.getTime() - action.createdAt.getTime() > 2 * 60 * 60_000;
}

function nextFinitePolicySlot(policy: ReminderPolicy, now: Date) {
  if (!policy.startsAt || !policy.endsAt) return null;
  if (now > policy.endsAt) return null;
  const reference = now < policy.startsAt ? new Date(policy.startsAt.getTime() - 1) : now;
  return nextGridSlot({
    anchor: policy.startsAt,
    intervalMinutes: policy.intervalMinutes ?? 30,
    after: reference,
    endsAt: policy.endsAt,
    inclusiveEnd: policy.windowEndInclusive,
  });
}

async function listDuplicateDenseReminderPolicyIds(userId: string) {
  const rows = await getDb().execute(sql`
    select r.policy_id as "policyId"
    from "assistant"."reminders" r
    join "assistant"."reminder_policies" p on p.id = r.policy_id
    where r.user_id = ${userId}::uuid
      and r.status in ('pending', 'claimed')
      and p.policy_type in ('interval_window', 'nag_until_ack')
    group by r.policy_id, date_trunc('minute', r.scheduled_at)
    having count(*) > 1
  `);
  return [
    ...new Set(
      (rows as unknown as Array<{ policyId: string | null }>)
        .map((row) => row.policyId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}
