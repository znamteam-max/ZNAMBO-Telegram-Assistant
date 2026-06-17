import type { MiddlewareFn } from "grammy";

import { writeAudit } from "@/db/queries/audit";
import { logger } from "@/lib/logger";
import { renderEntityCard } from "@/telegram/entityCards";

import type { BotContext } from "./context";

export const STALE_CALLBACK_MESSAGE =
  "Эта кнопка устарела. Обновил карточку — выбери действие заново.";

export function callbackReliabilityMiddleware(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const callbackData = ctx.callbackQuery?.data;
    if (!callbackData) {
      await next();
      return;
    }

    const ownerId = ctx.owner?.id;
    const auditBase = callbackAuditDetails(ctx, callbackData);
    if (ownerId) {
      await writeAudit({
        userId: ownerId,
        action: "assistant.callback_received",
        entityType: "telegram_callback",
        details: auditBase,
      }).catch(() => undefined);
      if (usesShortCallbackAlias(callbackData)) {
        await writeAudit({
          userId: ownerId,
          action: "assistant.callback_payload_shortened",
          entityType: "telegram_callback",
          details: {
            ...auditBase,
            callbackType: callbackData.split(":")[0] ?? callbackData,
            byteLength: Buffer.byteLength(callbackData, "utf8"),
          },
        }).catch(() => undefined);
      }
    }

    let answered = false;
    let fallbackExpired = false;
    const originalAnswer = ctx.answerCallbackQuery.bind(ctx) as BotContext["answerCallbackQuery"];
    ctx.answerCallbackQuery = (async (...args: Parameters<BotContext["answerCallbackQuery"]>) => {
      answered = true;
      return originalAnswer(...args);
    }) as BotContext["answerCallbackQuery"];

    try {
      await next();
      if (!answered) {
        await originalAnswer({ text: "Кнопка устарела", show_alert: false }).catch(() => null);
        answered = true;
        fallbackExpired = true;
        if (ownerId) {
          await writeAudit({
            userId: ownerId,
            action: "assistant.callback_expired",
            entityType: "telegram_callback",
            details: { ...auditBase, reason: "no_callback_handler_answered" },
          }).catch(() => undefined);
        }
        await ctx.reply(STALE_CALLBACK_MESSAGE).catch(() => null);
      }
      if (ownerId) {
        await writeAudit({
          userId: ownerId,
          action: "assistant.callback_completed",
          entityType: "telegram_callback",
          details: { ...auditBase, answered },
        }).catch(() => undefined);
        await writeCallbackHandled(ownerId, ctx, callbackData, {
          status: fallbackExpired ? "stale" : "handled",
          userFacingResponse: fallbackExpired ? STALE_CALLBACK_MESSAGE : undefined,
        });
      }
    } catch (error) {
      const safeErrorMessage = error instanceof Error ? error.message.slice(0, 240) : String(error);
      if (!answered) {
        await originalAnswer({ text: "Не смог обработать кнопку", show_alert: false }).catch(
          () => null,
        );
        answered = true;
      }
      if (ownerId) {
        await writeAudit({
          userId: ownerId,
          action: "assistant.callback_error",
          entityType: "telegram_callback",
          details: { ...auditBase, answered, safeErrorMessage },
        }).catch(() => undefined);
        await writeCallbackHandled(ownerId, ctx, callbackData, {
          status: "error",
          safeErrorMessage,
          userFacingResponse:
            "Не смог обработать кнопку. Обновил карточку — выбери действие заново.",
        });
      }
      logger.warn("Telegram callback failed safely", {
        callbackData: truncateCallbackData(callbackData),
        error: safeErrorMessage,
      });
      await ctx
        .reply("Не смог обработать кнопку. Обновил карточку — выбери действие заново.")
        .catch(() => null);
    }
  };
}

export async function replyStaleCallback(
  ctx: BotContext,
  options: { itemId?: string | null; reason?: string } = {},
) {
  const ownerId = ctx.owner?.id;
  const callbackData = ctx.callbackQuery?.data ?? "unknown";
  await ctx.answerCallbackQuery({ text: "Устарело", show_alert: false }).catch(() => null);
  if (ownerId) {
    await writeAudit({
      userId: ownerId,
      action: "assistant.callback_stale_session",
      entityType: "telegram_callback",
      details: {
        ...callbackAuditDetails(ctx, callbackData),
        reason: options.reason ?? "stale_session",
        itemId: options.itemId ?? null,
      },
    }).catch(() => undefined);
    await writeCallbackHandled(ownerId, ctx, callbackData, {
      status: "stale",
      userFacingResponse: STALE_CALLBACK_MESSAGE,
      itemId: options.itemId ?? null,
    });
  }
  await ctx.reply(STALE_CALLBACK_MESSAGE).catch(() => null);
  if (ownerId && options.itemId) {
    const card = await renderEntityCard({
      userId: ownerId,
      timezone: ctx.owner?.timezone ?? "Europe/Moscow",
      ref: { type: "planner_item", id: options.itemId },
    }).catch(() => null);
    if (card) {
      await ctx.reply(card.text, { reply_markup: card.keyboard }).catch(() => null);
      await writeAudit({
        userId: ownerId,
        action: "assistant.callback_message_refresh_sent",
        entityType: "planner_item",
        entityId: options.itemId,
        details: { callbackData: truncateCallbackData(callbackData) },
      }).catch(() => undefined);
    }
  }
}

function callbackAuditDetails(ctx: BotContext, callbackData: string) {
  const message = ctx.callbackQuery?.message;
  return {
    callbackData: truncateCallbackData(callbackData),
    updateId: ctx.update.update_id,
    callbackQueryId: ctx.callbackQuery?.id ?? null,
    chatId: message?.chat.id ? String(message.chat.id) : null,
    messageId: message?.message_id ?? null,
  };
}

async function writeCallbackHandled(
  userId: string,
  ctx: BotContext,
  callbackData: string,
  details: {
    status: "handled" | "error" | "stale";
    userFacingResponse?: string;
    safeErrorMessage?: string;
    itemId?: string | null;
  },
) {
  await writeAudit({
    userId,
    action: "assistant.callback_handled",
    entityType: "telegram_callback",
    details: {
      ...callbackAuditDetails(ctx, callbackData),
      callbackType: callbackData.split(":")[0] ?? callbackData,
      targetIds: extractUuidLikeIds(callbackData),
      status: details.status,
      userFacingResponse: details.userFacingResponse ?? null,
      safeErrorMessage: details.safeErrorMessage ?? null,
      itemId: details.itemId ?? null,
    },
  }).catch(() => undefined);
}

function extractUuidLikeIds(value: string) {
  return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
}

function truncateCallbackData(value: string) {
  return value.length > 240 ? `${value.slice(0, 240)}…` : value;
}

function usesShortCallbackAlias(value: string) {
  return /^(?:iemm|ipc|ipcab|pca|isi|r:(?:cmt|sto))(?::|$)/.test(value);
}
