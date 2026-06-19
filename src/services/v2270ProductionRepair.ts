import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { actionPlanSchema } from "@/ai/schemas";
import type { AgentReminderPolicy } from "@/ai/schemas/agentExecution";
import { getDb } from "@/db/client";
import { listPendingAgentActionsByTypes, updateAgentAction } from "@/db/queries/agentActions";
import { listRecentAuditLogs, writeAudit } from "@/db/queries/audit";
import {
  actionPlans,
  reminderPolicies,
  telegramMessages,
  type ActionPlanRecord,
  type AgentAction,
} from "@/db/schema";
import { detectOpenEndedUntilDoneIntent } from "@/domain/openEndedUntilDoneIntent";

const STALE_SESSION_TYPES = ["recurring_policy_draft", "recurring_policy_duplicate_decision"];

type V2270Candidates = {
  stalePendingPlans: ActionPlanRecord[];
  staleSessions: AgentAction[];
  failedUntilDoneDrafts: number;
  recurringPoliciesMissingInitialFireButSourceUntilDone: number;
};

export async function previewV2270ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const candidates = await collectV2270Candidates(params);
  return {
    failedUntilDoneDrafts: candidates.failedUntilDoneDrafts,
    stalePendingPlansMissingUntilDonePolicy: candidates.stalePendingPlans.length,
    recurringPoliciesMissingInitialFireButSourceUntilDone:
      candidates.recurringPoliciesMissingInitialFireButSourceUntilDone,
    staleSessionsToClear: candidates.staleSessions.length,
    calendarObjectsToChange: 0 as const,
    safeToApply: true as const,
  };
}

export async function applyV2270ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const candidates = await collectV2270Candidates({ ...params, now });
  const cancelledPendingPlanIds = candidates.stalePendingPlans.map((plan) => plan.id);
  if (cancelledPendingPlanIds.length) {
    await getDb()
      .update(actionPlans)
      .set({
        status: "cancelled",
        cancelledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(actionPlans.userId, params.userId),
          inArray(actionPlans.id, cancelledPendingPlanIds),
        ),
      );
  }

  const clearedSessionIds: string[] = [];
  for (const session of candidates.staleSessions) {
    const updated = await updateAgentAction({
      userId: params.userId,
      actionId: session.id,
      status: "cancelled",
      output: {
        ...(session.output ?? {}),
        cancelledAt: now.toISOString(),
        cancelledReason: "until_done_phrase_order_v2270_repair",
      },
    });
    if (updated) clearedSessionIds.push(updated.id);
  }

  const result = {
    cancelledStalePendingPlans: cancelledPendingPlanIds.length,
    cancelledStalePendingPlanIds: cancelledPendingPlanIds,
    clearedStaleSessions: clearedSessionIds.length,
    clearedStaleSessionIds: clearedSessionIds,
    createdUserTasks: 0 as const,
    calendarObjectsChanged: 0 as const,
    safeToApply: true as const,
  };
  await writeAudit({
    userId: params.userId,
    action: "assistant.v2270_repair_apply",
    entityType: "user",
    entityId: params.userId,
    details: result,
  }).catch(() => undefined);
  return result;
}

async function collectV2270Candidates(params: {
  userId: string;
  timezone: string;
  now?: Date;
}): Promise<V2270Candidates> {
  const now = params.now ?? new Date();
  const [pendingPlans, sessions, recentAudits, brokenPolicies] = await Promise.all([
    getRecentPendingPlansWithSourceText(params.userId),
    listPendingAgentActionsByTypes({
      userId: params.userId,
      actionTypes: STALE_SESSION_TYPES,
      limit: 100,
    }),
    listRecentAuditLogs({
      userId: params.userId,
      since: new Date(now.getTime() - 7 * 24 * 60 * 60_000),
      limit: 200,
    }),
    getBrokenRecurringPolicies(params.userId),
  ]);

  const stalePendingPlans = pendingPlans
    .filter((entry) =>
      Boolean(
        detectOpenEndedUntilDoneIntent({
          text: entry.sourceText,
          timezone: params.timezone,
          now,
        }),
      ),
    )
    .filter((entry) => !payloadHasUntilDonePolicy(entry.plan.payload))
    .map((entry) => entry.plan);

  const staleSessions = sessions.filter((session) => sessionLooksLikeBrokenUntilDoneDraft(session));
  const failedUntilDoneDrafts = recentAudits.filter((audit) => {
    const details = audit.details ?? {};
    const safeError = String(details.safeErrorMessage ?? details.errorCode ?? "");
    return /missing_initial_fire|policy_initial_fire_rejected|recurring_policy_missing/i.test(
      safeError,
    );
  }).length;

  return {
    stalePendingPlans,
    staleSessions,
    failedUntilDoneDrafts,
    recurringPoliciesMissingInitialFireButSourceUntilDone: brokenPolicies.length,
  };
}

async function getRecentPendingPlansWithSourceText(userId: string) {
  const rows = await getDb()
    .select({
      plan: actionPlans,
      text: telegramMessages.text,
      transcript: telegramMessages.transcript,
    })
    .from(actionPlans)
    .leftJoin(telegramMessages, eq(actionPlans.sourceMessageId, telegramMessages.id))
    .where(and(eq(actionPlans.userId, userId), eq(actionPlans.status, "pending")))
    .orderBy(desc(actionPlans.createdAt))
    .limit(100);
  return rows.map((row) => ({
    plan: row.plan,
    sourceText: [row.text, row.transcript].filter(Boolean).join("\n"),
  }));
}

async function getBrokenRecurringPolicies(userId: string) {
  return getDb()
    .select({ id: reminderPolicies.id })
    .from(reminderPolicies)
    .where(
      and(
        eq(reminderPolicies.userId, userId),
        eq(reminderPolicies.status, "active"),
        eq(reminderPolicies.policyType, "recurring"),
        eq(reminderPolicies.requireAck, true),
        sql`${reminderPolicies.nextFireAt} is null`,
      ),
    )
    .limit(100);
}

function payloadHasUntilDonePolicy(payload: Record<string, unknown>) {
  const parsed = actionPlanSchema.safeParse(payload);
  const payloadPolicies = Array.isArray(payload.reminderPolicies)
    ? (payload.reminderPolicies as AgentReminderPolicy[])
    : [];
  return (
    payloadPolicies.some((policy) => policy.policyType === "nag_until_ack" && policy.requireAck) ||
    parsed.data?.actions.some((action) => action.metadata?.stopCondition === "until_done") === true
  );
}

function sessionLooksLikeBrokenUntilDoneDraft(session: AgentAction) {
  if (!STALE_SESSION_TYPES.includes(session.actionType)) return false;
  const policies = Array.isArray(session.output?.policies)
    ? (session.output.policies as AgentReminderPolicy[])
    : [];
  return policies.some(
    (policy) =>
      policy.policyType === "recurring" &&
      policy.requireAck === true &&
      !policy.startsAtLocal &&
      !policy.nextFireAtLocal,
  );
}
