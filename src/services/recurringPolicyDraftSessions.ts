import { DateTime } from "luxon";

import { actionPlanSchema, type ActionPlan } from "@/ai/schemas";
import {
  agentReminderPolicySchema,
  type AgentReminderPolicy,
} from "@/ai/schemas/agentExecution";
import {
  getAgentActionById,
  getLatestAgentActionByStatus,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import {
  nextRecurringOccurrence,
  withRecurringPolicyTime,
} from "@/domain/recurringPolicySemantics";

const ACTION_TYPE = "recurring_policy_draft";
const TTL_MINUTES = 45;

export async function startRecurringPolicyDraftSession(params: {
  userId: string;
  sourceMessageId?: string | null;
  plan: ActionPlan;
  policies: AgentReminderPolicy[];
  timezone: string;
  now?: Date;
}) {
  await clearActiveRecurringPolicyDraftSession({
    userId: params.userId,
    reason: "replaced_by_new_recurring_policy_draft",
  });
  const now = params.now ?? new Date();
  const expiresAt = DateTime.fromJSDate(now, { zone: "utc" })
    .plus({ minutes: TTL_MINUTES })
    .toJSDate();
  return recordAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: ACTION_TYPE,
    status: "pending",
    input: { timezone: params.timezone },
    output: {
      plan: params.plan,
      policies: params.policies,
      timezone: params.timezone,
      expiresAt: expiresAt.toISOString(),
    },
  });
}

export async function getActiveRecurringPolicyDraftSession(params: {
  userId: string;
  actionId?: string | null;
  now?: Date;
}) {
  const action = params.actionId
    ? await getAgentActionById({ userId: params.userId, actionId: params.actionId })
    : await getLatestAgentActionByStatus({
        userId: params.userId,
        actionType: ACTION_TYPE,
        status: "pending",
      });
  if (!action || action.actionType !== ACTION_TYPE || action.status !== "pending") return null;
  const expiresAt = parseDate(action.output?.expiresAt);
  if (!expiresAt || expiresAt <= (params.now ?? new Date())) {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: { ...(action.output ?? {}), cancelledReason: "expired_or_invalid" },
    });
    return null;
  }
  const parsedPlan = actionPlanSchema.safeParse(action.output?.plan);
  const parsedPolicies = Array.isArray(action.output?.policies)
    ? action.output.policies.map((policy) => agentReminderPolicySchema.safeParse(policy))
    : [];
  if (!parsedPlan.success || parsedPolicies.some((policy) => !policy.success)) return null;
  return {
    action,
    plan: parsedPlan.data,
    policies: parsedPolicies.map((policy) => policy.data!),
    timezone:
      typeof action.output?.timezone === "string"
        ? action.output.timezone
        : "Europe/Moscow",
  };
}

export function applyTimeToRecurringPolicyDraft(params: {
  plan: ActionPlan;
  policies: AgentReminderPolicy[];
  timeLocal: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const policies = params.policies.map((policy) => {
    const recurrenceRule = policy.recurrenceRule
      ? withRecurringPolicyTime(policy.recurrenceRule, params.timeLocal)
      : policy.recurrenceRule;
    const next = nextRecurringOccurrence({
      rule: recurrenceRule,
      after: now,
      timezone: params.timezone,
    });
    return {
      ...policy,
      recurrenceRule,
      nextFireAtLocal: next
        ? DateTime.fromJSDate(next, { zone: "utc" })
            .setZone(params.timezone)
            .toFormat("yyyy-MM-dd'T'HH:mm:ss")
        : null,
    };
  });
  const plan: ActionPlan = {
    ...params.plan,
    requiresConfirmation: false,
    actions: params.plan.actions.map((action) => ({
      ...action,
      requiresConfirmation: false,
      recurrence: action.recurrence
        ? { ...action.recurrence, timeLocal: params.timeLocal }
        : action.recurrence,
      metadata: {
        ...action.metadata,
        timeUnspecified: false,
        recurrenceRule: policies.find((policy) => policy.itemTitle === action.title)?.recurrenceRule,
      },
    })),
  };
  return { plan, policies };
}

export async function finishRecurringPolicyDraftSession(params: {
  userId: string;
  actionId: string;
  status: "completed" | "cancelled" | "failed";
  details?: Record<string, unknown>;
}) {
  const current = await getAgentActionById({
    userId: params.userId,
    actionId: params.actionId,
  });
  if (!current) return null;
  return updateAgentAction({
    userId: params.userId,
    actionId: params.actionId,
    status: params.status,
    output: {
      ...(current.output ?? {}),
      ...(params.details ?? {}),
      finishedAt: new Date().toISOString(),
    },
  });
}

export async function clearActiveRecurringPolicyDraftSession(params: {
  userId: string;
  reason?: string;
}) {
  const action = await getLatestAgentActionByStatus({
    userId: params.userId,
    actionType: ACTION_TYPE,
    status: "pending",
  });
  if (!action) return null;
  return updateAgentAction({
    userId: params.userId,
    actionId: action.id,
    status: "cancelled",
    output: {
      ...(action.output ?? {}),
      cancelledReason: params.reason ?? "cleared",
      cancelledAt: new Date().toISOString(),
    },
  });
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
