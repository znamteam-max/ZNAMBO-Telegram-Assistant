import {
  getAgentActionById,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import { getPlannerItemById, listManageableItems } from "@/db/queries/items";
import { listReminderPoliciesForItem } from "@/db/queries/reminderPolicies";
import type { PlannerItem } from "@/db/schema";
import {
  applyItemEditMutation,
  formatItemEditApplied,
  formatItemEditPreview,
  parseItemEditMutation,
  type ItemEditMutation,
} from "@/services/itemEditMutations";
import {
  clearActiveItemEditSession,
  getActiveItemEditSession,
} from "@/services/itemEditSessions";
import {
  formatCalendarSyncFeedback,
  syncItemsToCalendarBestEffort,
} from "@/services/calendarBestEffort";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";
import { detectPlanConflicts, formatConflictLine } from "@/services/planConflicts";
import { logger } from "@/lib/logger";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import {
  conflictKeyboard,
  itemEditPreviewKeyboard,
  multiReminderConflictKeyboard,
  undoActionKeyboard,
} from "./keyboards";
import { replyAndRecord } from "./reply";
import { replyStaleCallback } from "./callbackReliability";

export async function handleItemEditTurn(
  ctx: BotContext,
  text: string,
  timezone: string,
): Promise<boolean> {
  const owner = requireOwner(ctx);
  let session;
  try {
    session = await getActiveItemEditSession({ userId: owner.id });
  } catch (error) {
    logger.warn("Item edit session lookup skipped", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (!session) return false;

  let mutation = parseItemEditMutation({
    text,
    item: session.item,
    timezone,
  });
  if (!mutation.changedFields.length) {
    await replyAndRecord(
      ctx,
      [
        `Я редактирую «${session.item.title}».`,
        "Не увидел конкретного изменения. Напиши, например: «переименуй на \"...\" и поставь на понедельник в 8 утра».",
      ].join("\n"),
    );
    return true;
  }

  if (
    mutation.reminderPolicy?.policyType === "before_event_multi" &&
    mutation.reminderPolicy.mode === "ask"
  ) {
    const existing = (await listReminderPoliciesForItem(owner.id, session.item.id, 100)).filter(
      (policy) => policy.status === "active" && policy.policyType === "before_event",
    );
    if (!existing.length) {
      mutation = {
        ...mutation,
        reminderPolicy: { ...mutation.reminderPolicy, mode: "add" },
      };
    } else {
      const preview = await recordAgentAction({
        userId: owner.id,
        sourceMessageId: ctx.dbMessageId,
        actionType: "item_edit_preview",
        status: "pending",
        input: {
          text: text.slice(0, 1200),
          sessionActionId: session.action.id,
          itemId: session.item.id,
        },
        output: {
          itemId: session.item.id,
          mutation,
          existingBeforeEventPolicyIds: existing.map((policy) => policy.id),
          expiresAt: session.expiresAt.toISOString(),
        },
      });
      await replyAndRecord(
        ctx,
        [
          `У «${session.item.title}» уже есть напоминания перед событием: ${existing.length}.`,
          "Добавить новые к существующим или заменить существующие?",
        ].join("\n"),
        { reply_markup: preview ? multiReminderConflictKeyboard(preview.id) : undefined },
      );
      return true;
    }
  }

  const canApplyDirectly =
    session.mode === "time" &&
    mutation.changedFields.length === 1 &&
    mutation.changedFields[0] === "schedule" &&
    !mutation.pastConfirmationRequired;
  if (canApplyDirectly) {
    await applyAndReply({
      ctx,
      item: session.item,
      mutation,
      timezone,
      sourceMessageId: ctx.dbMessageId,
    });
    await clearActiveItemEditSession({ userId: owner.id, reason: "direct_item_edit_applied" });
    return true;
  }

  const preview = await recordAgentAction({
    userId: owner.id,
    sourceMessageId: ctx.dbMessageId,
    actionType: "item_edit_preview",
    status: "pending",
    input: {
      text: text.slice(0, 1200),
      sessionActionId: session.action.id,
      itemId: session.item.id,
    },
    output: {
      itemId: session.item.id,
      mutation,
      expiresAt: session.expiresAt.toISOString(),
    },
  });
  await replyAndRecord(ctx, formatItemEditPreview({ item: session.item, mutation, timezone }), {
    reply_markup: preview ? itemEditPreviewKeyboard(preview.id) : undefined,
  });
  return true;
}

export async function chooseMultiReminderMode(
  ctx: BotContext,
  actionId: string,
  mode: "add" | "replace",
) {
  const owner = requireOwner(ctx);
  const action = await getAgentActionById({ userId: owner.id, actionId });
  if (!action || action.actionType !== "item_edit_preview" || action.status !== "pending") {
    await replyStaleCallback(ctx, { reason: "item_edit_multi_reminder_preview_missing" });
    return;
  }
  const mutation = parseStoredMutation(action.output?.mutation);
  if (!mutation || mutation.reminderPolicy?.policyType !== "before_event_multi") {
    await updateAgentAction({ userId: owner.id, actionId, status: "failed" });
    await ctx.answerCallbackQuery("Не удалось прочитать напоминания");
    return;
  }
  await updateAgentAction({
    userId: owner.id,
    actionId,
    status: "pending",
    output: {
      ...(action.output ?? {}),
      mutation: {
        ...mutation,
        reminderPolicy: { ...mutation.reminderPolicy, mode },
      },
      reminderConflictDecision: mode,
    },
  });
  await confirmItemEditPreview(ctx, actionId);
}

export async function confirmItemEditPreview(ctx: BotContext, actionId: string) {
  const owner = requireOwner(ctx);
  const action = await getAgentActionById({ userId: owner.id, actionId });
  if (!action || action.actionType !== "item_edit_preview" || action.status !== "pending") {
    await replyStaleCallback(ctx, { reason: "item_edit_preview_missing" });
    return;
  }
  const output = action.output as {
    itemId?: string;
    mutation?: unknown;
  };
  const itemId = typeof output.itemId === "string" ? output.itemId : null;
  const mutation = parseStoredMutation(output.mutation);
  if (!itemId || !mutation) {
    await updateAgentAction({ userId: owner.id, actionId, status: "failed" });
    await ctx.answerCallbackQuery("Не удалось применить");
    await replyAndRecord(ctx, "Не смог безопасно прочитать изменение. Ничего не поменял.");
    return;
  }
  const item = await getPlannerItemById(owner.id, itemId);
  if (!item || item.status !== "active") {
    await updateAgentAction({ userId: owner.id, actionId, status: "failed" });
    await ctx.answerCallbackQuery("Запись не найдена");
    await replyAndRecord(ctx, "Не нашёл активную запись для изменения.");
    return;
  }
  await ctx.answerCallbackQuery("Применяю");
  const result = await applyAndReply({
    ctx,
    item,
    mutation,
    timezone: owner.timezone,
    sourceMessageId: action.sourceMessageId,
  });
  await updateAgentAction({
    userId: owner.id,
    actionId,
    status: "completed",
    output: {
      ...action.output,
      updatedItemIds: result.item ? [result.item.id] : [],
      createdPolicyIds: result.policyIds,
      createdReminderIds: result.reminderIds,
    },
    undoPayload: result.undoPayload,
  });
  await clearActiveItemEditSession({ userId: owner.id, reason: "preview_confirmed" });
}

export async function cancelItemEditPreview(ctx: BotContext, actionId: string) {
  const owner = requireOwner(ctx);
  const action = await getAgentActionById({ userId: owner.id, actionId });
  if (action?.status === "pending") {
    await updateAgentAction({
      userId: owner.id,
      actionId,
      status: "cancelled",
      output: { ...(action.output ?? {}), cancelledAt: new Date().toISOString() },
    });
  }
  await clearActiveItemEditSession({ userId: owner.id, reason: "preview_cancelled" });
  await ctx.answerCallbackQuery("Отменено");
  await replyAndRecord(ctx, "Отменил. Запись не менял.");
}

async function applyAndReply(params: {
  ctx: BotContext;
  item: PlannerItem;
  mutation: ItemEditMutation;
  timezone: string;
  sourceMessageId?: string | null;
}) {
  const owner = requireOwner(params.ctx);
  const result = await applyItemEditMutation({
    userId: owner.id,
    item: params.item,
    mutation: params.mutation,
    timezone: params.timezone,
    sourceMessageId: params.sourceMessageId,
  });
  const calendarResults = result.item ? await syncItemsToCalendarBestEffort([result.item]) : [];
  const calendarFeedback = formatCalendarSyncFeedback(calendarResults);
  if (result.item) {
    await recordAgentAction({
      userId: owner.id,
      sourceMessageId: params.sourceMessageId,
      actionType: "item_edit_apply",
      status: "completed",
      input: { itemId: params.item.id, mutation: params.mutation },
      output: {
        updatedItemIds: [result.item.id],
        createdPolicyIds: result.policyIds,
        createdReminderIds: result.reminderIds,
        warnings: result.warnings,
      },
      undoPayload: result.undoPayload,
    });
    await replyAndRecord(
      params.ctx,
      formatItemEditApplied({
        item: result.item,
        mutation: params.mutation,
        timezone: params.timezone,
        calendarFeedback,
      }),
      { reply_markup: undoActionKeyboard() },
    );
    await sendConflictHintIfNeeded(params.ctx, result.item);
    await refreshPlan(params.ctx);
  } else {
    await replyAndRecord(params.ctx, "Не смог обновить запись. Ничего не поменял.");
  }
  return result;
}

async function sendConflictHintIfNeeded(ctx: BotContext, item: PlannerItem) {
  const owner = requireOwner(ctx);
  const allItems = await listManageableItems(owner.id, 300);
  const conflict = detectPlanConflicts(allItems).find(
    (entry) => entry.first.id === item.id || entry.second.id === item.id,
  );
  if (!conflict) return;
  await replyAndRecord(
    ctx,
    ["⚠️ Накладка", "", formatConflictLine(conflict, owner.timezone), "", "Что делаем?"].join("\n"),
    { reply_markup: conflictKeyboard(conflict.first.id, conflict.second.id) },
  );
}

async function refreshPlan(ctx: BotContext) {
  const owner = requireOwner(ctx);
  if (!ctx.chat?.id) return;
  await refreshDashboardAfterMutation({
    userId: owner.id,
    chatId: ctx.chat.id,
    timezone: owner.timezone,
  });
}

function parseStoredMutation(value: unknown): ItemEditMutation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ItemEditMutation>;
  if (typeof candidate.itemId !== "string" || !Array.isArray(candidate.changedFields)) return null;
  return {
    itemId: candidate.itemId,
    ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
    ...(typeof candidate.kind === "string" ? { kind: candidate.kind } : {}),
    ...(typeof candidate.scheduledForLocal === "string"
      ? { scheduledForLocal: candidate.scheduledForLocal }
      : {}),
    ...(typeof candidate.endsAtLocal === "string" ? { endsAtLocal: candidate.endsAtLocal } : {}),
    ...(candidate.allDay === true ? { allDay: true } : {}),
    ...(typeof candidate.deadlineAtLocal === "string"
      ? { deadlineAtLocal: candidate.deadlineAtLocal }
      : {}),
    ...(candidate.clearDeadline === true ? { clearDeadline: true } : {}),
    ...(candidate.reminderPolicy ? { reminderPolicy: candidate.reminderPolicy } : {}),
    changedFields: candidate.changedFields.filter((field): field is string => typeof field === "string"),
    warnings: Array.isArray(candidate.warnings)
      ? candidate.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    pastConfirmationRequired: Boolean(candidate.pastConfirmationRequired),
  };
}
