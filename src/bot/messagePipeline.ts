import { DateTime } from "luxon";

import { buildActionPlan } from "@/ai/planner";
import { buildValidationFailureReply, validatePlannerItemsBeforeSave } from "@/ai/antiGarbageValidator";
import { decideUserIntentWithAI } from "@/ai/assistantDecision";
import type { ActionPlan } from "@/ai/schemas";
import type { AssistantDecision } from "@/ai/schemas/assistantDecision";
import { writeAudit } from "@/db/queries/audit";
import { listItemsBetween, listManageableItems, listOverdueOpenItems } from "@/db/queries/items";
import { createIdempotencyKey } from "@/lib/idempotency";
import {
  commitStoredActionPlan,
  createStoredActionPlan,
  shouldAutoCommitPlan,
} from "@/services/actionPlanCommit";
import { buildActionPlanFromDecision } from "@/services/assistantPlanBuilders";
import { syncItemsToCalendarBestEffort } from "@/services/calendarBestEffort";
import { buildActiveContext } from "@/services/contextRetrieval";
import { storePlanMemoryFacts } from "@/services/memory";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import {
  formatActionPlanCard,
  formatCommittedPlanSummary,
  formatItemList,
  formatTaskManagementView,
} from "./formatters";
import { actionPlanKeyboard, taskManagementKeyboard } from "./keyboards";
import { replyAndRecord } from "./reply";

export async function handleIncomingUserMessage(ctx: BotContext, text: string, timezone: string) {
  const owner = requireOwner(ctx);
  const now = new Date();
  const activeContext = await buildActiveContext({
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
    validatorWarnings: [],
    finalAction: "started",
    savedItemIds: [],
  };

  try {
    if (decision.intent === "manage_existing_items") {
      await renderTaskManagementView(ctx, "Текущие задачи");
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
      const result = await handleActionPlan(ctx, {
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

    const result = await handleActionPlan(ctx, {
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
  } finally {
    await saveAssistantDecisionTrace(ctx, trace);
  }
}

async function handleActionPlan(
  ctx: BotContext,
  params: {
    text: string;
    timezone: string;
    now: Date;
    activeContext: string;
    decision: AssistantDecision;
    plan: ActionPlan;
    forceCommit: boolean;
    committedIntro?: string;
  },
): Promise<{ finalAction: string; validatorWarnings: string[]; savedItemIds: string[] }> {
  const owner = requireOwner(ctx);

  if (params.plan.intent === "answer" || params.plan.intent === "clarify") {
    await replyAndRecord(ctx, formatActionPlanCard(params.plan, params.timezone));
    return { finalAction: `replied_${params.plan.intent}`, validatorWarnings: [], savedItemIds: [] };
  }

  const validation = validatePlannerItemsBeforeSave({
    plan: params.plan,
    originalMessage: params.text,
    decision: params.decision,
  });
  if (!validation.ok) {
    if (validation.warnings.some((warning) => warning.includes("management command"))) {
      await renderTaskManagementView(ctx, "Текущие задачи");
      return {
        finalAction: "blocked_garbage_and_rendered_management",
        validatorWarnings: validation.warnings,
        savedItemIds: [],
      };
    }

    await replyAndRecord(ctx, buildValidationFailureReply(validation.warnings));
    return {
      finalAction: "blocked_by_anti_garbage_validator",
      validatorWarnings: validation.warnings,
      savedItemIds: [],
    };
  }

  const storedPlan = await createStoredActionPlan({
    userId: owner.id,
    sourceMessageId: ctx.dbMessageId,
    plan: params.plan,
    idempotencyKey: createIdempotencyKey([owner.id, ctx.update.update_id, params.text, "decision-v3"]),
    commitMode: owner.smartCommitMode,
  });

  if (params.forceCommit || shouldAutoCommitPlan(params.plan, owner.smartCommitMode)) {
    const result = await commitStoredActionPlan({
      actionPlanId: storedPlan.id,
      userId: owner.id,
      timezone: params.timezone,
      now: params.now,
    });
    if (result.status === "committed") {
      await replyAndRecord(
        ctx,
        formatCommittedPlanSummary({
          items: result.items,
          reminderCount: result.reminders.length,
          timezone: params.timezone,
          intro: params.committedIntro,
        }),
      );
      await syncItemsToCalendarBestEffort(result.items);
      return {
        finalAction: "committed_action_plan",
        validatorWarnings: validation.warnings,
        savedItemIds: result.items.map((item) => item.id),
      };
    }
    if (result.status === "already_committed") {
      await replyAndRecord(ctx, "Этот план уже был сохранён.");
      return {
        finalAction: "already_committed",
        validatorWarnings: validation.warnings,
        savedItemIds: [],
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
  };
}

async function renderTaskManagementView(ctx: BotContext, title: string) {
  const owner = requireOwner(ctx);
  const items = await listManageableItems(owner.id, 30);
  await replyAndRecord(ctx, formatTaskManagementView({ title, items, timezone: owner.timezone }), {
    reply_markup: items.length ? taskManagementKeyboard(items) : undefined,
  });
}

async function answerStatusQuery(ctx: BotContext, decision: AssistantDecision) {
  const owner = requireOwner(ctx);
  const target = decision.managementRequest?.target ?? "today";
  if (target === "tasks" || target === "current") {
    await renderTaskManagementView(ctx, "Текущие задачи");
    return;
  }

  const nowLocal = DateTime.utc().setZone(owner.timezone);
  const dayFrom = target === "tomorrow" ? 1 : 0;
  const dayTo = target === "week" ? 7 : dayFrom + 1;
  const from = nowLocal.startOf("day").plus({ days: dayFrom }).toUTC().toJSDate();
  const to = nowLocal.startOf("day").plus({ days: dayTo }).minus({ milliseconds: 1 }).toUTC().toJSDate();
  const [items, overdue] = await Promise.all([
    listItemsBetween({ userId: owner.id, from, to }),
    target === "today" ? listOverdueOpenItems({ userId: owner.id, before: from, limit: 20 }) : Promise.resolve([]),
  ]);
  const combined = dedupeItems([...overdue, ...items]);
  const title = target === "tomorrow" ? "Завтра" : target === "week" ? "Ближайшие 7 дней" : "Сегодня";
  await replyAndRecord(ctx, formatItemList(title, combined, owner.timezone));
}

async function saveMemoryAndConfirm(ctx: BotContext, decision: AssistantDecision) {
  const owner = requireOwner(ctx);
  const candidates: ActionPlan["memoryCandidates"] = [...decision.memoryFacts, ...decision.correctionRules].map((fact) => ({
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

function dedupeItems<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

type DecisionTraceDraft = {
  rawText: string;
  intent: AssistantDecision["intent"];
  confidence: number;
  shouldCreateItems: boolean;
  extractedItemCount: number;
  activeContextPreview: string;
  validatorWarnings: string[];
  finalAction: string;
  savedItemIds: string[];
};
