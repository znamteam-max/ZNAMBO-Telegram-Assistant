import type { NextFunction } from "grammy";

import { recordTelegramUpdate } from "@/db/queries/messages";
import { recordIncomingConversationMessage } from "@/services/conversation";

import type { BotContext } from "./context";

export async function recordUpdateOnce(ctx: BotContext, next: NextFunction) {
  const message = ctx.message ?? ctx.editedMessage ?? ctx.callbackQuery?.message;
  const text = extractVisibleIncomingText(ctx);
  const messageType = detectMessageType(ctx);
  const dbMessageId = await recordTelegramUpdate({
    updateId: ctx.update.update_id,
    userId: ctx.owner?.id,
    telegramUserId: ctx.from?.id,
    chatId: ctx.chat?.id,
    telegramMessageId: message?.message_id,
    messageType,
    text,
    raw: ctx.update as unknown as Record<string, unknown>,
  });

  if (!dbMessageId) return;
  ctx.dbMessageId = dbMessageId;
  await recordIncomingConversationMessage({
    userId: ctx.owner?.id,
    telegramMessageId: dbMessageId,
    messageType,
    text,
    metadata: {
      updateId: ctx.update.update_id,
      edited: Boolean(ctx.editedMessage),
      telegramMessageId: message?.message_id ?? null,
      chatId: ctx.chat?.id ?? null,
      callbackData: ctx.callbackQuery?.data ?? null,
    },
  });
  await next();
}

function extractVisibleIncomingText(ctx: BotContext) {
  const message = ctx.message ?? ctx.editedMessage;
  if (message) {
    if ("text" in message && typeof message.text === "string") return message.text;
    if ("caption" in message && typeof message.caption === "string") return message.caption;
  }
  return ctx.callbackQuery?.data ?? null;
}

function detectMessageType(ctx: BotContext): string {
  const message = ctx.message ?? ctx.editedMessage;
  if (!message) return ctx.callbackQuery ? "callback" : "unknown";
  if ("text" in message) return "text";
  if ("voice" in message) return "voice";
  if ("audio" in message) return "audio";
  if ("video_note" in message) return "video_note";
  if ("video" in message) return "video";
  if ("photo" in message) return "photo";
  if ("document" in message) return "document";
  return "other";
}
