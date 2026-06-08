import { writeAudit } from "@/db/queries/audit";
import { logger } from "@/lib/logger";

import type { BotContext } from "@/bot/context";
import { requireOwner } from "@/bot/context";
import { executeActionPlanForMessage } from "@/bot/messagePipeline";
import { replyAndRecord } from "@/bot/reply";
import { taskManagementKeyboard } from "@/bot/keyboards";
import { MandatoryAiError, proposeAgentExecution, type AiCallTelemetry } from "@/ai/agentExecution";
import type { AgentExecution } from "@/ai/schemas/agentExecution";
import { storePlanMemoryFacts } from "@/services/memory";
import { applyAgentItemUpdates } from "@/services/agentItemUpdates";
import { filterDuplicateActionPlan } from "@/services/actionPlanDedup";
import { syncItemsToCalendarBestEffort } from "@/services/calendarBestEffort";
import { bindContextualCompletionTarget } from "@/services/contextualAgentBinding";
import { listManageableItems } from "@/db/queries/items";
import { listItemsByIds } from "@/db/queries/taskViewStates";
import { applyAgentReminderPolicies } from "@/services/reminderPolicyEngine";
import { refreshDashboardAfterMutation, renderReminderPolicyList } from "@/telegram/liveDashboard";

import { buildJarvisContext } from "./context/buildJarvisContext";
import { detectHardManagementIntent } from "./hardManagementIntent";
import { handleHardManagementIntent } from "./hardManagementRouter";
import {
  cleanupGarbageTool,
  prepareResetActivePlanTool,
  renderEveningReviewTool,
  renderScheduleViewTool,
  renderTaskViewTool,
  renderYesterdayReviewTool,
} from "./jarvisTools";
import type { JarvisToolResult } from "./types";

const AI_SAFE_FAILURE_REPLY =
  "Не могу безопасно обработать это сообщение без OpenAI. Ничего не создал и не изменил. Попробуй ещё раз чуть позже или проверь /aihealth.";

export async function handleJarvisTurn(ctx: BotContext, text: string, timezone: string) {
  const owner = requireOwner(ctx);
  const now = new Date();
  const preRouterIntent = detectHardManagementIntent(text);
  const trace: Record<string, unknown> = {
    pipelineUsed: "jarvis",
    preRouterIntent: preRouterIntent?.intent ?? null,
    aiRequired: !isAllowedDeterministicIntent(preRouterIntent?.intent),
    aiCalled: false,
    aiSucceeded: false,
    aiModel: null,
    openaiResponseId: null,
    requestStartedAt: null,
    requestFinishedAt: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    structuredOutputValid: false,
    toolCallsProposed: [],
    toolCallsExecuted: [],
    fallbackUsed: false,
    fallbackReason: null,
    validationWarnings: [],
    finalAction: "started",
    createdItemIds: [],
    updatedItemIds: [],
    createdPolicyIds: [],
    createdReminderIds: [],
    transactionStarted: false,
    transactionCommitted: false,
    transactionRolledBack: false,
    proposedMutationCount: 0,
    committedMutationCount: 0,
    partialMutationDetected: false,
    errorCode: null,
    safeErrorMessage: null,
  };

  try {
    if (isAllowedDeterministicIntent(preRouterIntent?.intent)) {
      const handled = await handleHardManagementIntent({ ctx, text, timezone, now });
      if (!handled) throw new Error("Deterministic management intent was not handled");
      trace.finalAction = `deterministic_${handled.intent}`;
      trace.toolCallsProposed = [handled.intent];
      trace.toolCallsExecuted = [handled.intent];
      trace.updatedItemIds = handled.result.affectedItemIds;
      await replyToolResult(ctx, handled.result);
      if (handled.result.affectedItemIds.length) {
        await refreshDashboardBestEffort(ctx, timezone);
      }
      return;
    }

    const jarvisContext = await buildJarvisContext({
      userId: owner.id,
      timezone,
      query: text,
      now,
    });
    const proposed = await proposeAgentExecution({
      text,
      timezone,
      now,
      activeContext: jarvisContext.activeContext,
      preRouterIntent: preRouterIntent?.intent ?? null,
    });
    applyAiTelemetry(trace, proposed.telemetry);
    const bound = bindContextualCompletionTarget({
      execution: proposed.execution,
      text,
      latestFollowupItemId: jarvisContext.latestFollowupItemId,
    });
    trace.proposedMutationCount =
      (bound.execution.actionPlan?.actions.length ?? 0) +
      bound.execution.itemUpdates.length +
      bound.execution.reminderPolicies.length;
    const executionResult = await executeAgentProposal({
      ctx,
      execution: bound.execution,
      text,
      timezone,
      now,
      activeContext: jarvisContext.activeContext,
    });
    trace.toolCallsExecuted = executionResult.toolCallsExecuted;
    trace.createdItemIds = executionResult.createdItemIds;
    trace.updatedItemIds = executionResult.updatedItemIds;
    trace.createdPolicyIds = executionResult.createdPolicyIds;
    trace.createdReminderIds = executionResult.createdReminderIds;
    trace.transactionStarted = executionResult.transactionStarted;
    trace.transactionCommitted = executionResult.transactionCommitted;
    trace.transactionRolledBack = executionResult.transactionRolledBack;
    trace.proposedMutationCount = executionResult.proposedMutationCount;
    trace.committedMutationCount = executionResult.committedMutationCount;
    trace.partialMutationDetected = executionResult.partialMutationDetected;
    trace.validationWarnings = [...bound.warnings, ...executionResult.validationWarnings];
    trace.finalAction = executionResult.finalAction;
    if (executionResult.mutationOccurred) {
      await refreshDashboardBestEffort(ctx, timezone);
    }
  } catch (error) {
    if (error instanceof MandatoryAiError) {
      applyAiTelemetry(trace, error.telemetry);
      trace.finalAction = "ai_required_failed_closed";
      await replyAndRecord(ctx, AI_SAFE_FAILURE_REPLY);
      return;
    }
    trace.finalAction = "agent_execution_failed_closed";
    if (Number(trace.proposedMutationCount) > 0) {
      trace.transactionStarted = true;
      trace.transactionCommitted = false;
      trace.transactionRolledBack = true;
      trace.committedMutationCount = 0;
      trace.partialMutationDetected = false;
    }
    trace.errorCode = "execution";
    trace.safeErrorMessage = "Agent tool execution failed safely.";
    logger.warn("Mandatory agent execution failed closed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await replyAndRecord(
      ctx,
      "Не получилось безопасно выполнить предложенные действия. Ничего дополнительно не создаю. Проверь /debuglast.",
    );
  } finally {
    await writeAudit({
      userId: owner.id,
      action: "assistant.agent_decision_trace",
      entityType: "telegram_message",
      entityId: ctx.dbMessageId,
      details: trace,
    });
  }
}

async function executeAgentProposal(params: {
  ctx: BotContext;
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
  activeContext: string;
}) {
  const owner = requireOwner(params.ctx);
  const base = {
    userId: owner.id,
    timezone: params.timezone,
    now: params.now,
    sourceMessageId: params.ctx.dbMessageId,
  };
  const result = {
    toolCallsExecuted: [] as string[],
    createdItemIds: [] as string[],
    updatedItemIds: [] as string[],
    createdPolicyIds: [] as string[],
    createdReminderIds: [] as string[],
    validationWarnings: [] as string[],
    finalAction: "agent_replied",
    mutationOccurred: false,
    transactionStarted: false,
    transactionCommitted: false,
    transactionRolledBack: false,
    proposedMutationCount: 0,
    committedMutationCount: 0,
    partialMutationDetected: false,
  };

  if (params.execution.actionPlan) {
    const deduped = await filterDuplicateActionPlan({
      userId: owner.id,
      timezone: params.timezone,
      plan: params.execution.actionPlan,
    });
    result.validationWarnings.push(...deduped.warnings);
    if (deduped.plan.actions.length) {
      result.toolCallsExecuted.push("create_action_plan");
      const actionResult = await executeActionPlanForMessage(params.ctx, {
        text: params.text,
        timezone: params.timezone,
        now: params.now,
        activeContext: params.activeContext,
        plan: deduped.plan,
        forceCommit: false,
        reminderPolicies: params.execution.reminderPolicies,
      });
      result.createdItemIds = actionResult.savedItemIds;
      result.createdPolicyIds = actionResult.createdPolicyIds ?? [];
      result.createdReminderIds = actionResult.createdReminderIds ?? [];
      result.transactionStarted = actionResult.transactionStarted ?? false;
      result.transactionCommitted = actionResult.transactionCommitted ?? false;
      result.transactionRolledBack = actionResult.transactionRolledBack ?? false;
      result.proposedMutationCount = actionResult.proposedMutationCount ?? 0;
      result.committedMutationCount = actionResult.committedMutationCount ?? 0;
      result.partialMutationDetected = actionResult.partialMutationDetected ?? false;
      result.mutationOccurred ||=
        actionResult.savedItemIds.length > 0 || result.createdPolicyIds.length > 0;
      result.validationWarnings.push(...actionResult.validatorWarnings);
      result.finalAction = actionResult.finalAction;
      if (result.createdPolicyIds.length) {
        result.toolCallsExecuted.push(
          ...new Set(params.execution.reminderPolicies.map((policy) => policy.operation)),
        );
      }
    } else if (!params.execution.reminderPolicies.length) {
      result.finalAction = "all_proposed_actions_already_exist";
    }
    if (!deduped.plan.actions.length && params.execution.reminderPolicies.length) {
      const policyResult = await executePolicyProposals({
        execution: params.execution,
        userId: owner.id,
        timezone: params.timezone,
        createdItemIds: result.createdItemIds,
        now: params.now,
      });
      result.toolCallsExecuted.push(...policyResult.toolCallsExecuted);
      result.validationWarnings.push(...policyResult.warnings);
      result.mutationOccurred ||= policyResult.policyCount > 0;
    }
    if (params.execution.viewScope) {
      const view = await executeViewOrManagementTool(params.execution, base);
      if (view) {
        result.toolCallsExecuted.push(view.name);
        await replyToolResult(params.ctx, view.result);
        result.finalAction = `${result.finalAction}_and_${view.name}`;
      }
    }
    return result;
  }

  if (params.execution.itemUpdates.length) {
    result.toolCallsExecuted.push("update_existing_items");
    const updateResult = await applyAgentItemUpdates({
      userId: owner.id,
      updates: params.execution.itemUpdates,
      timezone: params.timezone,
      sourceText: params.text,
      now: params.now,
    });
    result.updatedItemIds = updateResult.updatedItems.map((item) => item.id);
    result.mutationOccurred = updateResult.updatedItems.length > 0;
    result.validationWarnings = updateResult.warnings;
    result.finalAction = "updated_existing_items";
    await syncItemsToCalendarBestEffort(updateResult.updatedItems);
    const lines = [
      buildUpdateIntro(params.execution.reply, updateResult),
      "",
      ...updateResult.updatedItems.map((item) => `• ${item.title}`),
    ];
    if (updateResult.configuredItemIds.length || updateResult.reminderIds.length) {
      lines.push(
        updateResult.reminderIds.length
          ? `Напоминаний и follow-up создано: ${updateResult.reminderIds.length}.`
          : "Новых напоминаний не создано.",
      );
    }
    await replyAndRecord(params.ctx, lines.join("\n"), {
      reply_markup:
        updateResult.exposeManagementButtons && updateResult.updatedItems.length
          ? taskManagementKeyboard(updateResult.updatedItems)
          : undefined,
    });
    if (params.execution.reminderPolicies.length) {
      const policyResult = await executePolicyProposals({
        execution: params.execution,
        userId: owner.id,
        timezone: params.timezone,
        createdItemIds: [],
        now: params.now,
      });
      result.toolCallsExecuted.push(...policyResult.toolCallsExecuted);
      result.validationWarnings.push(...policyResult.warnings);
      result.mutationOccurred ||= policyResult.policyCount > 0;
    }
    return result;
  }

  if (params.execution.reminderPolicies.length) {
    const policyResult = await executePolicyProposals({
      execution: params.execution,
      userId: owner.id,
      timezone: params.timezone,
      createdItemIds: [],
      now: params.now,
    });
    result.toolCallsExecuted.push(...policyResult.toolCallsExecuted);
    result.validationWarnings.push(...policyResult.warnings);
    result.mutationOccurred = policyResult.policyCount > 0;
    result.finalAction = "updated_reminder_policies";
    await replyAndRecord(
      params.ctx,
      params.execution.reply ?? `Настроил политик напоминаний: ${policyResult.policyCount}.`,
    );
    return result;
  }

  if (params.execution.memoryFacts.length) {
    result.toolCallsExecuted.push("store_memory");
    await storePlanMemoryFacts({
      userId: owner.id,
      sourceMessageId: params.ctx.dbMessageId,
      plan: {
        intent: "answer",
        summary: null,
        reply: params.execution.reply,
        confidence: 0.9,
        requiresConfirmation: false,
        actions: [],
        memoryCandidates: params.execution.memoryFacts,
        clarificationQuestions: [],
      },
    });
    result.finalAction = "stored_memory";
    await replyAndRecord(params.ctx, params.execution.reply ?? "Запомнил.");
    return result;
  }

  const toolResult = await executeViewOrManagementTool(params.execution, base);
  if (toolResult) {
    result.toolCallsExecuted.push(toolResult.name);
    result.updatedItemIds = toolResult.result.affectedItemIds;
    result.finalAction = toolResult.name;
    result.mutationOccurred = toolResult.result.metadata?.dashboardRefreshRequested === true;
    await replyToolResult(params.ctx, toolResult.result);
    return result;
  }

  result.toolCallsExecuted.push(params.execution.intent);
  result.finalAction = params.execution.intent;
  const reply = [params.execution.reply, ...params.execution.clarificationQuestions]
    .filter(Boolean)
    .join("\n");
  await replyAndRecord(params.ctx, reply || "Уточни, пожалуйста, что именно нужно сделать.");
  return result;
}

function buildUpdateIntro(
  proposedReply: string | null,
  result: Awaited<ReturnType<typeof applyAgentItemUpdates>>,
) {
  if (result.completedItemIds.length && !result.rescheduledItemIds.length) {
    return "Готово. Отметил выполненным:";
  }
  if (result.rescheduledItemIds.length && !result.completedItemIds.length) {
    return "Обновил время:";
  }
  return proposedReply ?? "Обновил существующие события.";
}

async function executeViewOrManagementTool(
  execution: AgentExecution,
  base: {
    userId: string;
    timezone: string;
    now: Date;
    sourceMessageId?: string | null;
  },
): Promise<{ name: string; result: JarvisToolResult } | null> {
  if (execution.viewScope === "full") {
    return {
      name: "render_full",
      result: await renderScheduleViewTool({ ...base, scope: "full" }),
    };
  }
  if (execution.viewScope === "today") {
    return {
      name: "render_today",
      result: await renderScheduleViewTool({ ...base, scope: "today" }),
    };
  }
  if (execution.viewScope === "tomorrow") {
    return {
      name: "render_tomorrow",
      result: await renderScheduleViewTool({ ...base, scope: "tomorrow" }),
    };
  }
  if (execution.viewScope === "week") {
    return {
      name: "render_week",
      result: await renderScheduleViewTool({ ...base, scope: "week" }),
    };
  }
  if (execution.viewScope === "tasks") {
    return { name: "render_tasks", result: await renderTaskViewTool(base) };
  }
  if (execution.viewScope === "yesterday") {
    return { name: "render_yesterday", result: await renderYesterdayReviewTool(base) };
  }
  if (execution.viewScope === "evening") {
    return { name: "render_evening", result: await renderEveningReviewTool(base) };
  }
  if (execution.viewScope === "dashboard") {
    return {
      name: "render_dashboard",
      result: {
        handled: true,
        reply: "Обновляю живой план.",
        affectedItemIds: [],
        metadata: { dashboardRefreshRequested: true },
      },
    };
  }
  if (execution.viewScope === "reminders" || execution.viewScope === "longterm") {
    return {
      name: execution.viewScope === "longterm" ? "render_longterm" : "render_reminders",
      result: {
        handled: true,
        reply: await renderReminderPolicyList({
          userId: base.userId,
          timezone: base.timezone,
          longTermOnly: execution.viewScope === "longterm",
        }),
        affectedItemIds: [],
      },
    };
  }
  if (execution.resetMode === "all") {
    return { name: "prepare_reset_active_plan", result: await prepareResetActivePlanTool(base) };
  }
  if (execution.resetMode === "garbage" || execution.intent === "cleanup_garbage") {
    return { name: "cleanup_garbage", result: await cleanupGarbageTool(base) };
  }
  return null;
}

function isAllowedDeterministicIntent(intent?: string | null) {
  return (
    intent === "delete_by_indices" ||
    intent === "mark_done_by_indices" ||
    intent === "reschedule_by_indices"
  );
}

function applyAiTelemetry(trace: Record<string, unknown>, telemetry: AiCallTelemetry) {
  Object.assign(trace, telemetry);
}

async function replyToolResult(ctx: BotContext, result: JarvisToolResult) {
  await replyAndRecord(
    ctx,
    result.reply,
    result.replyMarkup ? { reply_markup: result.replyMarkup } : undefined,
  );
}

async function executePolicyProposals(params: {
  execution: AgentExecution;
  userId: string;
  timezone: string;
  createdItemIds: string[];
  now: Date;
}) {
  const [created, manageable] = await Promise.all([
    listItemsByIds(params.userId, params.createdItemIds),
    listManageableItems(params.userId, 100),
  ]);
  const availableItems = [
    ...new Map([...created, ...manageable].map((item) => [item.id, item])).values(),
  ];
  const applied = await applyAgentReminderPolicies({
    userId: params.userId,
    timezone: params.timezone,
    proposals: params.execution.reminderPolicies,
    availableItems,
    now: params.now,
  });
  return {
    policyCount: applied.policies.length,
    warnings: applied.warnings,
    toolCallsExecuted: [
      ...new Set(params.execution.reminderPolicies.map((policy) => policy.operation)),
    ],
  };
}

async function refreshDashboardBestEffort(ctx: BotContext, timezone: string) {
  if (!ctx.chat?.id || !ctx.owner) return;
  try {
    await refreshDashboardAfterMutation({
      userId: ctx.owner.id,
      chatId: ctx.chat.id,
      timezone,
    });
  } catch (error) {
    logger.warn("Live dashboard refresh failed without blocking mutation", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
