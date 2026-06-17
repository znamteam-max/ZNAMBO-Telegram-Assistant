import type { AgentExecution } from "@/ai/schemas/agentExecution";
import type { BotContext } from "@/bot/context";
import { requireOwner } from "@/bot/context";
import {
  recurringPolicyDuplicateKeyboard,
  recurringTimeClarificationKeyboard,
} from "@/bot/keyboards";
import { executeActionPlanForMessage } from "@/bot/messagePipeline";
import { replyAndRecord } from "@/bot/reply";
import { writeAudit } from "@/db/queries/audit";
import {
  applyTimeToRecurringPolicyDraft,
  applyTimeToExistingRecurringPolicyDraft,
  buildRecurringPolicyDraftIntents,
  finishRecurringPolicyDraftSession,
  getActiveRecurringPolicyDraftSession,
  getIncompleteRecurringPolicies,
  startRecurringPolicyDraftSession,
} from "@/services/recurringPolicyDraftSessions";
import { formatRecurringClarification } from "@/domain/recurringPolicySemantics";
import {
  findSimilarActiveRecurringPolicy,
  formatRecurringDuplicatePrompt,
  startRecurringPolicyDuplicateDecisionSession,
} from "@/services/recurringPolicyDuplicateDetection";

export function hasIncompleteRecurringPolicies(execution: AgentExecution) {
  return getIncompleteRecurringPolicies(execution.reminderPolicies).length > 0;
}

export async function presentRecurringPolicyClarification(params: {
  ctx: BotContext;
  execution: AgentExecution;
  timezone: string;
  now: Date;
}) {
  const owner = requireOwner(params.ctx);
  if (!params.execution.actionPlan) return false;
  const duplicate = await findSimilarActiveRecurringPolicy({
    userId: owner.id,
    policies: params.execution.reminderPolicies,
  }).catch(() => null);
  if (duplicate) {
    const action = await startRecurringPolicyDuplicateDecisionSession({
      userId: owner.id,
      sourceMessageId: params.ctx.dbMessageId,
      plan: params.execution.actionPlan,
      policies: params.execution.reminderPolicies,
      match: duplicate,
      timezone: params.timezone,
      now: params.now,
    });
    if (action) {
      await replyAndRecord(params.ctx, formatRecurringDuplicatePrompt(duplicate), {
        reply_markup: recurringPolicyDuplicateKeyboard(action.id),
      });
      return true;
    }
  }
  const action = await startRecurringPolicyDraftSession({
    userId: owner.id,
    sourceMessageId: params.ctx.dbMessageId,
    plan: params.execution.actionPlan,
    policies: params.execution.reminderPolicies,
    timezone: params.timezone,
    now: params.now,
  });
  if (!action) return false;
  const intents = buildRecurringPolicyDraftIntents(params.execution.reminderPolicies);
  if (intents.some((intent) => intent.recurrenceKind === "daily")) {
    await writeAudit({
      userId: owner.id,
      action: "assistant.daily_recurring_missing_time_draft_created",
      entityType: "telegram_message",
      entityId: params.ctx.dbMessageId,
      details: {
        draftActionId: action.id,
        policyTitles: intents.map((intent) => intent.title),
      },
    }).catch(() => undefined);
  }
  await replyAndRecord(params.ctx, [
    "deduped" in action && action.deduped === true
      ? "Уже держу этот черновик. Новую задачу не создаю."
      : null,
    formatRecurringClarification(intents),
  ].filter(Boolean).join("\n\n"), {
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
  if (session.updateExistingPolicyId) {
    const firstPolicy = finalized.policies[0];
    if (!firstPolicy) {
      await finishRecurringPolicyDraftSession({
        userId: owner.id,
        actionId,
        status: "failed",
        details: { selectedTime: timeLocal, safeError: "empty_recurring_policy_draft" },
      });
      await ctx.reply("Не смог прочитать черновик повторяющегося напоминания. Ничего не изменил.");
      return false;
    }
    const updated = await applyTimeToExistingRecurringPolicyDraft({
      userId: owner.id,
      policyId: session.updateExistingPolicyId,
      policy: firstPolicy,
      timeLocal,
      timezone: session.timezone || timezone,
      now: new Date(),
    });
    await finishRecurringPolicyDraftSession({
      userId: owner.id,
      actionId,
      status: updated.policy ? "completed" : "failed",
      details: {
        selectedTime: timeLocal,
        updatedPolicyId: updated.policy?.id ?? null,
        createdReminderId: updated.reminderId,
        finalAction: updated.policy
          ? "updated_existing_recurring_policy"
          : "existing_recurring_policy_update_failed",
      },
    });
    await ctx.reply(
      updated.policy
        ? `Обновил существующее повторяющееся напоминание: ${updated.policy.title} в ${timeLocal}.`
        : "Не нашёл существующее повторяющееся напоминание. Ничего не изменил.",
    );
    return Boolean(updated.policy);
  }
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
