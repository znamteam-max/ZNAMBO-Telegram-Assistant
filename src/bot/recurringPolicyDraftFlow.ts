import type { AgentExecution } from "@/ai/schemas/agentExecution";
import type { BotContext } from "@/bot/context";
import { requireOwner } from "@/bot/context";
import { recurringTimeClarificationKeyboard } from "@/bot/keyboards";
import { executeActionPlanForMessage } from "@/bot/messagePipeline";
import { replyAndRecord } from "@/bot/reply";
import {
  formatRecurringClarification,
  parseCanonicalRecurrenceRule,
} from "@/domain/recurringPolicySemantics";
import {
  applyTimeToRecurringPolicyDraft,
  finishRecurringPolicyDraftSession,
  getActiveRecurringPolicyDraftSession,
  startRecurringPolicyDraftSession,
} from "@/services/recurringPolicyDraftSessions";

export function hasIncompleteRecurringPolicies(execution: AgentExecution) {
  return execution.reminderPolicies.some((policy) => {
    const parsed = parseCanonicalRecurrenceRule(policy.recurrenceRule);
    return parsed && parsed.kind !== "legacy" && !parsed.timeLocal;
  });
}

export async function presentRecurringPolicyClarification(params: {
  ctx: BotContext;
  execution: AgentExecution;
  timezone: string;
  now: Date;
}) {
  const owner = requireOwner(params.ctx);
  if (!params.execution.actionPlan) return false;
  const action = await startRecurringPolicyDraftSession({
    userId: owner.id,
    sourceMessageId: params.ctx.dbMessageId,
    plan: params.execution.actionPlan,
    policies: params.execution.reminderPolicies,
    timezone: params.timezone,
    now: params.now,
  });
  if (!action) return false;
  const intents = params.execution.reminderPolicies.map((policy) => {
    const parsed = parseCanonicalRecurrenceRule(policy.recurrenceRule);
    return {
      title: policy.title,
      recurrenceRule: policy.recurrenceRule ?? "",
      recurrenceKind:
        parsed?.kind === "monthly_day_range"
          ? ("monthly_day_range" as const)
          : ("weekly" as const),
      weekday: parsed?.kind === "weekly" ? parsed.weekday : null,
      monthDays: parsed?.kind === "monthly_day_range" ? parsed.monthDays : [],
      timeLocal: null,
      requireAck: policy.requireAck,
      ackAliases: [],
      missingFields: ["reminderTime" as const],
    };
  });
  await replyAndRecord(params.ctx, formatRecurringClarification(intents), {
    reply_markup: recurringTimeClarificationKeyboard(action.id, intents.length > 1),
  });
  return true;
}

export async function handleRecurringPolicyDraftTurn(
  ctx: BotContext,
  text: string,
  timezone: string,
) {
  const owner = requireOwner(ctx);
  const session = await getActiveRecurringPolicyDraftSession({ userId: owner.id }).catch(() => null);
  if (!session) return false;
  const time = extractTime(text);
  if (!time) {
    await replyAndRecord(
      ctx,
      "Я жду время для повторяющегося напоминания. Напиши, например: «09:00» или «оба в 12:00».",
      { reply_markup: recurringTimeClarificationKeyboard(session.action.id, session.policies.length > 1) },
    );
    return true;
  }
  await applyRecurringPolicyDraftTime(ctx, session.action.id, time, timezone);
  return true;
}

export async function applyRecurringPolicyDraftTime(
  ctx: BotContext,
  actionId: string,
  timeLocal: string,
  timezone: string,
) {
  const owner = requireOwner(ctx);
  const session = await getActiveRecurringPolicyDraftSession({
    userId: owner.id,
    actionId,
  });
  if (!session) {
    await ctx.reply("Черновик напоминания истёк. Пришли правило ещё раз.");
    return false;
  }
  const finalized = applyTimeToRecurringPolicyDraft({
    plan: session.plan,
    policies: session.policies,
    timeLocal,
    timezone: session.timezone || timezone,
  });
  try {
    const result = await executeActionPlanForMessage(ctx, {
      text: `recurring draft ${actionId} at ${timeLocal}`,
      timezone: session.timezone || timezone,
      now: new Date(),
      activeContext: "recurring_policy_draft",
      plan: finalized.plan,
      forceCommit: true,
      reminderPolicies: finalized.policies,
      compactMode: false,
    });
    await finishRecurringPolicyDraftSession({
      userId: owner.id,
      actionId,
      status: result.transactionCommitted ? "completed" : "failed",
      details: {
        selectedTime: timeLocal,
        finalAction: result.finalAction,
        createdItemIds: result.savedItemIds,
        createdPolicyIds: result.createdPolicyIds ?? [],
      },
    });
    return result.transactionCommitted === true;
  } catch (error) {
    await finishRecurringPolicyDraftSession({
      userId: owner.id,
      actionId,
      status: "failed",
      details: {
        selectedTime: timeLocal,
        safeError: error instanceof Error ? error.message : "unknown",
      },
    });
    throw error;
  }
}

function extractTime(text: string) {
  const match = text.match(/(?:^|\s)(?:оба\s+в\s+|в\s+)?(\d{1,2})(?:[.:](\d{2}))?(?:\s|$)/i);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
