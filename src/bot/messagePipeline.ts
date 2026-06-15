import {
  detectHardManagementIntent,
  SAFE_MANAGEMENT_FALLBACK_REPLY,
} from "@/agent/hardManagementIntent";
import { handleHardManagementIntent } from "@/agent/hardManagementRouter";
import { renderScheduleViewTool, renderTaskViewTool } from "@/agent/jarvisTools";
import { buildActionPlan } from "@/ai/planner";
import {
  buildValidationFailureReply,
  validatePlannerItemsBeforeSave,
  validateReminderPoliciesBeforeSave,
} from "@/ai/antiGarbageValidator";
import { decideUserIntentWithAI } from "@/ai/assistantDecision";
import type { ActionPlan } from "@/ai/schemas";
import type { AgentReminderPolicy } from "@/ai/schemas/agentExecution";
import type { AssistantDecision } from "@/ai/schemas/assistantDecision";
import { writeAudit } from "@/db/queries/audit";
import { listManageableItems } from "@/db/queries/items";
import { createIdempotencyKey } from "@/lib/idempotency";
import {
  commitStoredActionPlan,
  createStoredActionPlan,
  shouldAutoCommitPlan,
} from "@/services/actionPlanCommit";
import { buildActionPlanFromDecision } from "@/services/assistantPlanBuilders";
import {
  formatCalendarSyncFeedback,
  syncItemsToCalendarBestEffort,
} from "@/services/calendarBestEffort";
import { buildActiveContext } from "@/services/contextRetrieval";
import { storePlanMemoryFacts } from "@/services/memory";
import { logger } from "@/lib/logger";
import { detectPlanConflicts, formatConflictLine } from "@/services/planConflicts";
import {
  buildRecurringPolicyDraftIntents,
  getIncompleteRecurringPolicies,
  startRecurringPolicyDraftSession,
} from "@/services/recurringPolicyDraftSessions";
import { formatRecurringClarification } from "@/domain/recurringPolicySemantics";
import {
  findSimilarActiveRecurringPolicy,
  formatRecurringDuplicatePrompt,
  startRecurringPolicyDuplicateDecisionSession,
} from "@/services/recurringPolicyDuplicateDetection";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { formatActionPlanCard, formatCommittedPlanSummary } from "./formatters";
import {
  actionPlanKeyboard,
  conflictKeyboard,
  postCreateTriageKeyboard,
  recurringPolicyDuplicateKeyboard,
  recurringTimeClarificationKeyboard,
} from "./keyboards";
import { replyAndRecord } from "./reply";
import { handleItemEditTurn } from "./itemEditFlow";

export async function handleIncomingUserMessage(ctx: BotContext, text: string, timezone: string) {
  const owner = requireOwner(ctx);
  const now = new Date();
  const itemEditHandled = await handleItemEditTurn(ctx, text, timezone);
  if (itemEditHandled) {
    await writeAudit({
      userId: owner.id,
      action: "assistant.decision_trace",
      entityType: "telegram_message",
      entityId: ctx.dbMessageId,
      details: {
        pipelineUsed: "legacy_v2",
        preRouterIntent: null,
        finalIntent: "item_edit_session",
        fallbackUsed: false,
        createItemAttempted: false,
        createItemBlockedByValidator: true,
        finalAction: "item_edit_session_handled",
      },
    });
    return;
  }
  const hardIntent = detectHardManagementIntent(text);
  if (hardIntent) {
    try {
      const handled = await handleHardManagementIntent({ ctx, text, timezone, now });
      if (handled) {
        await replyAndRecord(
          ctx,
          handled.result.reply,
          handled.result.replyMarkup ? { reply_markup: handled.result.replyMarkup } : undefined,
        );
      } else {
        await replyAndRecord(ctx, SAFE_MANAGEMENT_FALLBACK_REPLY);
      }
    } catch (error) {
      logger.warn("Legacy V2 hard management guard blocked fallback", {
        intent: hardIntent.intent,
        error: error instanceof Error ? error.message : String(error),
      });
      await replyAndRecord(ctx, SAFE_MANAGEMENT_FALLBACK_REPLY);
    }
    await writeAudit({
      userId: owner.id,
      action: "assistant.decision_trace",
      entityType: "telegram_message",
      entityId: ctx.dbMessageId,
      details: {
        pipelineUsed: "legacy_v2",
        preRouterIntent: hardIntent.intent,
        finalIntent: hardIntent.intent,
        fallbackUsed: false,
        createItemAttempted: false,
        createItemBlockedByValidator: true,
        finalAction: "hard_management_guard",
      },
    });
    return;
  }
  const { activeContext, contextError } = await buildActiveContextBestEffort({
    userId: owner.id,
    timezone,
    query: text,
    now,
  });
  const decision = await decideUserIntentWithAI({ text, timezone, now, activeContext });
  const trace: DecisionTraceDraft = {
    rawText: text.slice(0, 1200),
    intent: decision.intent,
    confidence: decision.confidence,
    shouldCreateItems: decision.shouldCreateItems,
    extractedItemCount: decision.extractedItems.length,
    activeContextPreview: activeContext.slice(0, 1600),
    contextError,
    validatorWarnings: [],
    finalAction: "started",
    savedItemIds: [],
    pipelineUsed: "legacy_v2",
    preRouterIntent: null,
    finalIntent: decision.intent,
    fallbackUsed: false,
    createItemAttempted: decision.shouldCreateItems,
    createItemBlockedByValidator: false,
  };

  try {
    if (decision.intent === "manage_existing_items") {
      await renderTaskManagementView(ctx);
      trace.finalAction = "rendered_task_management";
      return;
    }

    if (decision.intent === "status_query") {
      await answerStatusQuery(ctx, decision);
      trace.finalAction = `answered_status_${decision.managementRequest?.target ?? "today"}`;
      return;
    }

    if (decision.intent === "memory_update") {
      await saveMemoryAndConfirm(ctx, decision);
      trace.finalAction = "stored_memory";
      return;
    }

    const planFromDecision = buildActionPlanFromDecision({ decision, text, timezone, now });
    if (planFromDecision) {
      const result = await executeActionPlanForMessage(ctx, {
        text,
        timezone,
        now,
        activeContext,
        decision,
        plan: planFromDecision,
        forceCommit: true,
        committedIntro: buildCommittedIntro(decision),
      });
      trace.validatorWarnings = result.validatorWarnings;
      trace.finalAction = result.finalAction;
      trace.savedItemIds = result.savedItemIds;
      trace.createItemBlockedByValidator = result.finalAction.includes("blocked");
      return;
    }

    const plan = await buildActionPlan({ text, timezone, activeContext, now });
    if (plan.memoryCandidates.length && plan.actions.length === 0) {
      await storePlanMemoryFacts({
        userId: owner.id,
        sourceMessageId: ctx.dbMessageId,
        plan,
      });
      await replyAndRecord(ctx, plan.reply || "Запомнил. Буду учитывать это дальше.");
      trace.finalAction = "stored_planner_memory";
      return;
    }

    const result = await executeActionPlanForMessage(ctx, {
      text,
      timezone,
      now,
      activeContext,
      decision,
      plan,
      forceCommit: false,
    });
    trace.validatorWarnings = result.validatorWarnings;
    trace.finalAction = result.finalAction;
    trace.savedItemIds = result.savedItemIds;
    trace.createItemBlockedByValidator = result.finalAction.includes("blocked");
  } finally {
    await saveAssistantDecisionTrace(ctx, trace);
  }
}

async function buildActiveContextBestEffort(params: {
  userId: string;
  timezone: string;
  query: string;
  now: Date;
}) {
  try {
    return {
      activeContext: await buildActiveContext(params),
      contextError: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Active context retrieval failed", { error: message });
    return {
      activeContext: `Context retrieval failed; continue without blocking. Error: ${message}`,
      contextError: message,
    };
  }
}

export async function executeActionPlanForMessage(
  ctx: BotContext,
  params: {
    text: string;
    timezone: string;
    now: Date;
    activeContext: string;
    decision?: AssistantDecision;
    plan: ActionPlan;
    forceCommit: boolean;
    committedIntro?: string;
    reminderPolicies?: AgentReminderPolicy[];
    compactMode?: boolean;
  },
): Promise<{
  finalAction: string;
  validatorWarnings: string[];
  savedItemIds: string[];
  createdPolicyIds?: string[];
  createdReminderIds?: string[];
  transactionStarted?: boolean;
  transactionCommitted?: boolean;
  transactionRolledBack?: boolean;
  proposedMutationCount?: number;
  committedMutationCount?: number;
  partialMutationDetected?: boolean;
}> {
  const owner = requireOwner(ctx);
  if (params.plan.intent === "answer" || params.plan.intent === "clarify") {
    await replyAndRecord(ctx, formatActionPlanCard(params.plan, params.timezone));
    return {
      finalAction: `replied_${params.plan.intent}`,
      validatorWarnings: [],
      savedItemIds: [],
    };
  }

  const recurringDraft = await blockIncompleteRecurringPoliciesWithDraft(ctx, params);
  if (recurringDraft) return recurringDraft;

  const validation = validatePlannerItemsBeforeSave({
    plan: params.plan,
    originalMessage: params.text,
    decision: params.decision,
  });
  const policyValidation = validateReminderPoliciesBeforeSave({
    plan: params.plan,
    policies: params.reminderPolicies ?? [],
    timezone: params.timezone,
    originalMessage: params.text,
  });
  validation.warnings.push(...policyValidation.warnings);
  validation.ok = validation.ok && policyValidation.ok;
  if (!validation.ok) {
    if (validation.warnings.some((warning) => warning.includes("management command"))) {
      await renderTaskManagementView(ctx);
      return {
        finalAction: "blocked_garbage_and_rendered_management",
        validatorWarnings: validation.warnings,
        savedItemIds: [],
        transactionStarted: false,
        transactionCommitted: false,
        transactionRolledBack: false,
        proposedMutationCount: params.plan.actions.length + (params.reminderPolicies?.length ?? 0),
        committedMutationCount: 0,
        partialMutationDetected: false,
      };
    }

    await replyAndRecord(ctx, buildValidationFailureReply(validation.warnings));
    return {
      finalAction: "blocked_by_anti_garbage_validator",
      validatorWarnings: validation.warnings,
      savedItemIds: [],
      transactionStarted: false,
      transactionCommitted: false,
      transactionRolledBack: false,
      proposedMutationCount: params.plan.actions.length + (params.reminderPolicies?.length ?? 0),
      committedMutationCount: 0,
      partialMutationDetected: false,
    };
  }

  const storedPlan = await createStoredActionPlan({
    userId: owner.id,
    sourceMessageId: ctx.dbMessageId,
    plan: params.plan,
    idempotencyKey: createIdempotencyKey([
      owner.id,
      ctx.update.update_id,
      params.text,
      "decision-v3",
    ]),
    commitMode: owner.smartCommitMode,
    reminderPolicies: params.reminderPolicies,
  });

  if (params.forceCommit || shouldAutoCommitPlan(params.plan, owner.smartCommitMode)) {
    const result = await commitStoredActionPlan({
      actionPlanId: storedPlan.id,
      userId: owner.id,
      timezone: params.timezone,
      now: params.now,
      reminderPolicies: params.reminderPolicies,
    });
    if (result.status === "committed") {
      const calendarResults = await syncItemsToCalendarBestEffort(result.items);
      const calendarFeedback = formatCalendarSyncFeedback(calendarResults);
      await replyAndRecord(
        ctx,
        [
          formatCommittedPlanSummary({
            items: result.items,
            reminderCount: result.reminders.length,
            timezone: params.timezone,
            intro: params.committedIntro,
          }),
          calendarFeedback,
        ]
          .filter(Boolean)
          .join("\n\n"),
        result.items.length
          ? { reply_markup: postCreateTriageKeyboard(result.items) }
          : undefined,
      );
      await replyCreatedConflicts(ctx, owner.id, result.items, params.timezone);
      return {
        finalAction: "committed_action_plan",
        validatorWarnings: validation.warnings,
        savedItemIds: result.items.map((item) => item.id),
        createdPolicyIds: result.policies.map((policy) => policy.id),
        createdReminderIds: result.policyReminderIds,
        transactionStarted: true,
        transactionCommitted: true,
        transactionRolledBack: false,
        proposedMutationCount: params.plan.actions.length + (params.reminderPolicies?.length ?? 0),
        committedMutationCount:
          result.items.length + result.policies.length + result.policyReminderIds.length,
        partialMutationDetected: false,
      };
    }
    if (result.status === "already_committed") {
      if (!params.compactMode) await replyAndRecord(ctx, "Этот план уже был сохранён.");
      return {
        finalAction: "already_committed",
        validatorWarnings: validation.warnings,
        savedItemIds: [],
        transactionStarted: true,
        transactionCommitted: true,
        transactionRolledBack: false,
        proposedMutationCount: params.plan.actions.length + (params.reminderPolicies?.length ?? 0),
        committedMutationCount: 0,
        partialMutationDetected: false,
      };
    }
  }

  await replyAndRecord(ctx, formatActionPlanCard(params.plan, params.timezone), {
    reply_markup: actionPlanKeyboard(storedPlan.id),
  });
  return {
    finalAction: "presented_pending_action_plan",
    validatorWarnings: validation.warnings,
    savedItemIds: [],
    transactionStarted: false,
    transactionCommitted: false,
    transactionRolledBack: false,
    proposedMutationCount: params.plan.actions.length + (params.reminderPolicies?.length ?? 0),
    committedMutationCount: 0,
    partialMutationDetected: false,
  };
}

async function blockIncompleteRecurringPoliciesWithDraft(
  ctx: BotContext,
  params: {
    text: string;
    timezone: string;
    now: Date;
    plan: ActionPlan;
    reminderPolicies?: AgentReminderPolicy[];
  },
): Promise<{
  finalAction: string;
  validatorWarnings: string[];
  savedItemIds: string[];
  createdPolicyIds: string[];
  createdReminderIds: string[];
  transactionStarted: false;
  transactionCommitted: false;
  transactionRolledBack: false;
  proposedMutationCount: number;
  committedMutationCount: 0;
  partialMutationDetected: false;
} | null> {
  const owner = requireOwner(ctx);
  const policies = params.reminderPolicies ?? [];
  if (!getIncompleteRecurringPolicies(policies).length) return null;
  const duplicate = await findSimilarActiveRecurringPolicy({
    userId: owner.id,
    policies,
  }).catch(() => null);
  if (duplicate) {
    const duplicateAction = await startRecurringPolicyDuplicateDecisionSession({
      userId: owner.id,
      sourceMessageId: ctx.dbMessageId,
      plan: params.plan,
      policies,
      match: duplicate,
      timezone: params.timezone,
      now: params.now,
    });
    if (duplicateAction) {
      await replyAndRecord(ctx, formatRecurringDuplicatePrompt(duplicate), {
        reply_markup: recurringPolicyDuplicateKeyboard(duplicateAction.id),
      });
      return {
        finalAction: "recurring_policy_duplicate_needs_decision",
        validatorWarnings: ["recurring_policy_missing_time", "similar_active_recurring_policy_found"],
        savedItemIds: [],
        createdPolicyIds: [],
        createdReminderIds: [],
        transactionStarted: false,
        transactionCommitted: false,
        transactionRolledBack: false,
        proposedMutationCount: params.plan.actions.length + policies.length,
        committedMutationCount: 0,
        partialMutationDetected: false,
      };
    }
  }
  const action = await startRecurringPolicyDraftSession({
    userId: owner.id,
    sourceMessageId: ctx.dbMessageId,
    plan: params.plan,
    policies,
    timezone: params.timezone,
    now: params.now,
  });
  if (!action) {
    await replyAndRecord(
      ctx,
      "Понял повторяющееся напоминание, но не смог безопасно открыть черновик. Ничего не создал.",
    );
    return {
      finalAction: "recurring_time_clarification_failed",
      validatorWarnings: ["recurring_policy_missing_time", "recurring_draft_create_failed"],
      savedItemIds: [],
      createdPolicyIds: [],
      createdReminderIds: [],
      transactionStarted: false,
      transactionCommitted: false,
      transactionRolledBack: false,
      proposedMutationCount: params.plan.actions.length + policies.length,
      committedMutationCount: 0,
      partialMutationDetected: false,
    };
  }
  const intents = buildRecurringPolicyDraftIntents(policies);
  await replyAndRecord(
    ctx,
    [
      "deduped" in action && action.deduped === true
        ? "Уже держу этот черновик. Новую задачу не создаю."
        : null,
      formatRecurringClarification(intents),
    ]
      .filter(Boolean)
      .join("\n\n"),
    {
      reply_markup: recurringTimeClarificationKeyboard(action.id, intents.length > 1),
    },
  );
  return {
    finalAction: "recurring_policy_needs_clarification",
    validatorWarnings: ["recurring_policy_missing_time"],
    savedItemIds: [],
    createdPolicyIds: [],
    createdReminderIds: [],
    transactionStarted: false,
    transactionCommitted: false,
    transactionRolledBack: false,
    proposedMutationCount: params.plan.actions.length + policies.length,
    committedMutationCount: 0,
    partialMutationDetected: false,
  };
}

async function replyCreatedConflicts(
  ctx: BotContext,
  userId: string,
  createdItems: Awaited<ReturnType<typeof listManageableItems>>,
  timezone: string,
) {
  if (!createdItems.length) return;
  const createdIds = new Set(createdItems.map((item) => item.id));
  const allItems = await listManageableItems(userId, 300);
  const conflict = detectPlanConflicts(allItems).find(
    (entry) => createdIds.has(entry.first.id) || createdIds.has(entry.second.id),
  );
  if (!conflict) return;
  await replyAndRecord(
    ctx,
    [
      "⚠️ Накладка",
      "",
      formatConflictLine(conflict, timezone),
      "",
      "Что делаем?",
    ].join("\n"),
    { reply_markup: conflictKeyboard(conflict.first.id, conflict.second.id) },
  );
}

async function renderTaskManagementView(ctx: BotContext) {
  const owner = requireOwner(ctx);
  const result = await renderTaskViewTool({
    userId: owner.id,
    timezone: owner.timezone,
    sourceMessageId: ctx.dbMessageId,
  });
  await replyAndRecord(ctx, result.reply);
}

async function answerStatusQuery(ctx: BotContext, decision: AssistantDecision) {
  const owner = requireOwner(ctx);
  const target = decision.managementRequest?.target ?? "today";
  if (target === "tasks" || target === "current") {
    await renderTaskManagementView(ctx);
    return;
  }
  const scope = target === "tomorrow" ? "tomorrow" : target === "week" ? "week" : "today";
  const result = await renderScheduleViewTool({
    userId: owner.id,
    timezone: owner.timezone,
    sourceMessageId: ctx.dbMessageId,
    scope,
  });
  await replyAndRecord(ctx, result.reply);
}

async function saveMemoryAndConfirm(ctx: BotContext, decision: AssistantDecision) {
  const owner = requireOwner(ctx);
  const candidates: ActionPlan["memoryCandidates"] = [
    ...decision.memoryFacts,
    ...decision.correctionRules,
  ].map((fact) => ({
    category: fact.category === "meeting_pattern" ? "meeting_pattern" : "preference",
    content: fact.content,
    searchTags: fact.searchTags ?? [],
  }));
  await storePlanMemoryFacts({
    userId: owner.id,
    sourceMessageId: ctx.dbMessageId,
    plan: {
      intent: "answer",
      summary: null,
      reply: decision.userFacingSummary,
      confidence: decision.confidence,
      requiresConfirmation: false,
      actions: [],
      memoryCandidates: candidates,
      clarificationQuestions: [],
    },
  });
  await replyAndRecord(ctx, decision.userFacingSummary || "Запомнил. Буду учитывать это дальше.");
}

function buildCommittedIntro(decision: AssistantDecision): string {
  if (decision.intent === "ordered_task_list" && decision.orderedTasks) {
    return `Понял, это список дел на день. Сохранил ${decision.orderedTasks.items.length} пунктов по порядку.`;
  }
  if (decision.intent === "training_report" || decision.intent === "tentative_training_plan") {
    return "Понял. Отметил тренировочный статус и предварительный план.";
  }
  return "✅ Записал:";
}

async function saveAssistantDecisionTrace(ctx: BotContext, trace: DecisionTraceDraft) {
  const owner = ctx.owner;
  if (!owner) return;
  await writeAudit({
    userId: owner.id,
    action: "assistant.decision_trace",
    entityType: "telegram_message",
    entityId: ctx.dbMessageId,
    details: trace,
  });
}

type DecisionTraceDraft = {
  rawText: string;
  intent: AssistantDecision["intent"];
  confidence: number;
  shouldCreateItems: boolean;
  extractedItemCount: number;
  activeContextPreview: string;
  contextError: string | null;
  validatorWarnings: string[];
  finalAction: string;
  savedItemIds: string[];
  pipelineUsed: "legacy_v2";
  preRouterIntent: string | null;
  finalIntent: string;
  fallbackUsed: boolean;
  createItemAttempted: boolean;
  createItemBlockedByValidator: boolean;
};
