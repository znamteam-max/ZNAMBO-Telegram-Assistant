import { writeAudit } from "@/db/queries/audit";
import { logger } from "@/lib/logger";

import type { BotContext } from "@/bot/context";
import { requireOwner } from "@/bot/context";
import { handleIncomingUserMessage } from "@/bot/messagePipeline";
import { replyAndRecord } from "@/bot/reply";

import { buildJarvisContext } from "./context/buildJarvisContext";
import { detectHardManagementIntent, SAFE_MANAGEMENT_FALLBACK_REPLY } from "./hardManagementIntent";
import { handleHardManagementIntent } from "./hardManagementRouter";
import { decideJarvisTurn } from "./jarvisDecision";
import {
  cleanupGarbageTool,
  deleteItemsByIndicesTool,
  markDoneByIndicesTool,
  renderEveningReviewTool,
  renderRecentRangeTool,
  renderScheduleViewTool,
  renderTaskViewTool,
  renderYesterdayReviewTool,
  undoLastActionTool,
} from "./jarvisTools";
import { validateJarvisDecision } from "./validation/decisionValidator";
import type { JarvisToolResult } from "./types";

export async function handleJarvisTurn(ctx: BotContext, text: string, timezone: string) {
  const owner = requireOwner(ctx);
  const now = new Date();
  const preRouterIntent = detectHardManagementIntent(text);
  const hardTrace: Record<string, unknown> = {
    rawText: text.slice(0, 1200),
    pipelineUsed: "jarvis",
    preRouterIntent: preRouterIntent?.intent ?? null,
    finalIntent: null,
    fallbackUsed: false,
    createItemAttempted: false,
    createItemBlockedByValidator: false,
    finalAction: "hard_router_started",
  };
  if (preRouterIntent) {
    try {
      const handled = await handleHardManagementIntent({ ctx, text, timezone, now });
      hardTrace.finalIntent = handled?.intent ?? preRouterIntent.intent;
      hardTrace.finalAction = `hard_management_${handled?.intent ?? preRouterIntent.intent}`;
      if (handled) {
        hardTrace.affectedItemIds = handled.result.affectedItemIds;
        await replyToolResult(ctx, handled.result);
      } else {
        await replyAndRecord(ctx, SAFE_MANAGEMENT_FALLBACK_REPLY);
      }
    } catch (error) {
      hardTrace.finalIntent = preRouterIntent.intent;
      hardTrace.finalAction = "hard_management_safe_failure";
      hardTrace.error = error instanceof Error ? error.message : String(error);
      logger.warn("Hard management handler failed without legacy fallback", {
        intent: preRouterIntent.intent,
        error: hardTrace.error,
      });
      await replyAndRecord(ctx, SAFE_MANAGEMENT_FALLBACK_REPLY);
    } finally {
      await writeAudit({
        userId: owner.id,
        action: "assistant.jarvis_trace",
        entityType: "telegram_message",
        entityId: ctx.dbMessageId,
        details: hardTrace,
      });
    }
    return;
  }

  const jarvisContext = await buildJarvisContext({
    userId: owner.id,
    timezone,
    query: text,
    now,
  });
  const decision = decideJarvisTurn(text);
  const validation = validateJarvisDecision(decision);

  const trace: Record<string, unknown> = {
    rawText: text.slice(0, 1200),
    pipelineUsed: "jarvis",
    preRouterIntent: null,
    finalIntent: decision.intent,
    fallbackUsed: false,
    createItemAttempted: decision.shouldCreateItems,
    createItemBlockedByValidator: false,
    intent: decision.intent,
    mode: decision.mode,
    confidence: decision.confidence,
    shouldCreateItems: decision.shouldCreateItems,
    toolName: decision.toolName,
    reason: decision.reason,
    validationWarnings: validation.warnings,
    contextError: jarvisContext.contextError,
    lastTaskViewStateId: jarvisContext.lastTaskViewState?.id ?? null,
    finalAction: "started",
  };

  try {
    if (!validation.ok) {
      trace.finalAction = "blocked_by_jarvis_decision_validator";
      await replyAndRecord(ctx, "Остановил действие: команда управления не должна создавать новые задачи. Покажи список через /tasks или «дай план целиком».");
      return;
    }

    const result = await executeJarvisTool({
      ctx,
      text,
      timezone,
      now,
      intent: decision.intent,
    });

    if (result?.handled) {
      trace.finalAction = `jarvis_tool_${decision.intent}`;
      trace.affectedItemIds = result.affectedItemIds;
      trace.viewStateId = result.viewStateId ?? null;
      await replyToolResult(ctx, result);
      return;
    }

    trace.finalAction = "delegated_to_v2_planner";
    trace.fallbackUsed = true;
    await handleIncomingUserMessage(ctx, text, timezone);
  } catch (error) {
    trace.finalAction = "jarvis_error";
    trace.error = error instanceof Error ? error.message : String(error);
    logger.warn("Jarvis pipeline failed", {
      error: trace.error,
      intent: decision.intent,
    });
    if (decision.intent === "delegate_to_planner") {
      trace.fallbackUsed = true;
      await handleIncomingUserMessage(ctx, text, timezone);
    } else {
      await replyAndRecord(ctx, SAFE_MANAGEMENT_FALLBACK_REPLY);
    }
  } finally {
    await writeAudit({
      userId: owner.id,
      action: "assistant.jarvis_trace",
      entityType: "telegram_message",
      entityId: ctx.dbMessageId,
      details: trace,
    });
  }
}

async function executeJarvisTool(params: {
  ctx: BotContext;
  text: string;
  timezone: string;
  now: Date;
  intent: ReturnType<typeof decideJarvisTurn>["intent"];
}): Promise<JarvisToolResult | null> {
  const owner = requireOwner(params.ctx);
  const base = {
    userId: owner.id,
    timezone: params.timezone,
    now: params.now,
    sourceMessageId: params.ctx.dbMessageId,
  };

  switch (params.intent) {
    case "render_full_plan":
      return renderScheduleViewTool({ ...base, scope: "full" });
    case "render_today":
      return renderScheduleViewTool({ ...base, scope: "today" });
    case "render_tomorrow":
      return renderScheduleViewTool({ ...base, scope: "tomorrow" });
    case "render_week":
      return renderScheduleViewTool({ ...base, scope: "week" });
    case "render_recent_range":
      return renderRecentRangeTool({ ...base, days: 2 });
    case "render_tasks":
      return renderTaskViewTool(base);
    case "render_yesterday_review":
      return renderYesterdayReviewTool(base);
    case "render_evening_review":
      return renderEveningReviewTool(base);
    case "delete_by_indices":
      return deleteItemsByIndicesTool({ ...base, text: params.text });
    case "mark_done_by_indices":
      return markDoneByIndicesTool({ ...base, text: params.text });
    case "cleanup_garbage":
      return cleanupGarbageTool(base);
    case "reset_active_plan":
      return null;
    case "undo_last_action":
      return undoLastActionTool(base);
    case "delegate_to_planner":
      return null;
  }
}

async function replyToolResult(ctx: BotContext, result: JarvisToolResult) {
  await replyAndRecord(
    ctx,
    result.reply,
    result.replyMarkup ? { reply_markup: result.replyMarkup } : undefined,
  );
}
