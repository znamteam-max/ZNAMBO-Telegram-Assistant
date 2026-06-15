import { DateTime } from "luxon";

import type { ActionPlan } from "@/ai/schemas";
import type { AgentReminderPolicy } from "@/ai/schemas/agentExecution";
import {
  getAgentActionById,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import { listActiveReminderPolicies } from "@/db/queries/reminderPolicies";
import type { AgentAction, ReminderPolicy } from "@/db/schema";
import { parseCanonicalRecurrenceRule } from "@/domain/recurringPolicySemantics";

const ACTION_TYPE = "recurring_policy_duplicate_decision";
const TTL_MINUTES = 30;

export type RecurringPolicyDuplicateMatch = {
  existing: ReminderPolicy;
  proposed: AgentReminderPolicy;
  similarity: number;
  recurrenceFamily: string;
};

export async function findSimilarActiveRecurringPolicy(params: {
  userId: string;
  policies: AgentReminderPolicy[];
}) {
  const candidates = params.policies.filter((policy) =>
    ["recurring", "long_term"].includes(policy.policyType),
  );
  if (!candidates.length) return null;
  const active = await listActiveReminderPolicies(params.userId, 300);
  let best: RecurringPolicyDuplicateMatch | null = null;
  for (const proposed of candidates) {
    const proposedFamily = recurrenceFamily(proposed.recurrenceRule);
    const proposedKey = titleKey(proposed.title || proposed.itemTitle || "");
    if (!proposedKey) continue;
    for (const existing of active) {
      if (!["recurring", "long_term"].includes(existing.policyType)) continue;
      if (recurrenceFamily(existing.recurrenceRule) !== proposedFamily) continue;
      const similarity = tokenSimilarity(proposedKey, titleKey(existing.title));
      if (similarity < 0.4) continue;
      if (!best || similarity > best.similarity) {
        best = { existing, proposed, similarity, recurrenceFamily: proposedFamily };
      }
    }
  }
  return best;
}

export async function startRecurringPolicyDuplicateDecisionSession(params: {
  userId: string;
  sourceMessageId?: string | null;
  plan: ActionPlan;
  policies: AgentReminderPolicy[];
  match: RecurringPolicyDuplicateMatch;
  timezone: string;
  now?: Date;
}) {
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
      existingPolicyId: params.match.existing.id,
      existingTitle: params.match.existing.title,
      proposedTitle: params.match.proposed.title,
      recurrenceFamily: params.match.recurrenceFamily,
      similarity: params.match.similarity,
      expiresAt: expiresAt.toISOString(),
    },
  });
}

export async function getRecurringPolicyDuplicateDecisionSession(params: {
  userId: string;
  actionId: string;
  now?: Date;
}) {
  const action = await getAgentActionById({ userId: params.userId, actionId: params.actionId });
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
  return {
    action,
    plan: action.output?.plan as ActionPlan,
    policies: Array.isArray(action.output?.policies)
      ? (action.output.policies as AgentReminderPolicy[])
      : [],
    timezone:
      typeof action.output?.timezone === "string"
        ? action.output.timezone
        : "Europe/Moscow",
    existingPolicyId:
      typeof action.output?.existingPolicyId === "string"
        ? action.output.existingPolicyId
        : null,
  };
}

export function formatRecurringDuplicatePrompt(match: RecurringPolicyDuplicateMatch) {
  return [
    "Похоже, такое повторяющееся напоминание уже есть.",
    "",
    `Существующее: ${match.existing.title}`,
    `Новое: ${match.proposed.title}`,
    "",
    "Обновить существующее, создать отдельное или отменить?",
  ].join("\n");
}

export async function finishRecurringPolicyDuplicateDecision(params: {
  userId: string;
  action: AgentAction;
  status: "completed" | "cancelled";
  decision: string;
}) {
  return updateAgentAction({
    userId: params.userId,
    actionId: params.action.id,
    status: params.status,
    output: {
      ...(params.action.output ?? {}),
      decision: params.decision,
      finishedAt: new Date().toISOString(),
    },
  });
}

function recurrenceFamily(rule: string | null) {
  const parsed = parseCanonicalRecurrenceRule(rule);
  if (parsed?.kind === "weekly") return `weekly:${parsed.weekday}`;
  if (parsed?.kind === "monthly_day_range") return `monthly:${parsed.monthDays.join(",")}`;
  return (rule ?? "none").toLocaleLowerCase("ru").replace(/@\d{2}:\d{2}/, "");
}

function titleKey(value: string) {
  return value
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/\b(?:напомнить|напоминай|каждый|каждую|понедельник|понедельникам|надо|нужно)\b/giu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenSimilarity(left: string, right: string) {
  const a = new Set(left.split(/\s+/).filter(isMeaningfulToken).map(stemToken));
  const b = new Set(right.split(/\s+/).filter(isMeaningfulToken).map(stemToken));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.max(a.size, b.size);
}

function stemToken(token: string) {
  return token.length > 6 ? token.slice(0, 6) : token;
}

function isMeaningfulToken(token: string) {
  return token.length > 2 && !/^(?:мне|для|про|надо|нужно)$/i.test(token);
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
