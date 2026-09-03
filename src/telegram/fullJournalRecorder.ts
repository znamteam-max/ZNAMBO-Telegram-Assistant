import type { Bot } from "grammy";

import type { BotContext } from "@/bot/context";
import { getUserByTelegramId } from "@/db/queries/users";
import { logger } from "@/lib/logger";
import { recordAssistantConversationMessage } from "@/services/conversation";

const SEND_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendVideo",
  "sendAudio",
  "sendVoice",
  "sendAnimation",
  "sendDocument",
]);

const EDIT_METHODS = new Set(["editMessageText", "editMessageCaption", "editMessageReplyMarkup"]);

export function installFullJournalTelegramRecorder(bot: Bot<BotContext>) {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    if (SEND_METHODS.has(method) || EDIT_METHODS.has(method) || method === "deleteMessage") {
      try {
        await recordTelegramApiEvent(method, payload as unknown as Record<string, unknown>, response);
      } catch (error) {
        // Journaling must never make a successful Telegram action fail for the user.
        logger.warn("Full journal Telegram recorder failed", {
          method,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return response;
  });
}

async function recordTelegramApiEvent(
  method: string,
  payload: Record<string, unknown>,
  response: unknown,
) {
  const chatId = normalizeChatId(payload.chat_id);
  if (!chatId) return;
  const user = await getUserByTelegramId(chatId);
  if (!user) return;

  const outboundMessageId =
    normalizeMessageId(payload.message_id) ?? extractResponseMessageId(response) ?? null;
  const eventType = SEND_METHODS.has(method)
    ? "telegram_send"
    : method === "deleteMessage"
      ? "telegram_delete"
      : "telegram_edit";
  const text = extractVisibleText(payload, method);

  await recordAssistantConversationMessage({
    userId: user.id,
    text,
    messageType: eventType,
    metadata: {
      journalVersion: 1,
      telegramMethod: method,
      telegramOutboundMessageId: outboundMessageId,
      chatId,
      lifecycle: eventType === "telegram_delete" ? "deleted" : eventType === "telegram_edit" ? "edited" : "sent",
      hasReplyMarkup: Boolean(payload.reply_markup),
      mediaType: SEND_METHODS.has(method) && method !== "sendMessage" ? method.slice(4).toLowerCase() : null,
    },
  });
}

function extractVisibleText(payload: Record<string, unknown>, method: string) {
  if (method === "deleteMessage" || method === "editMessageReplyMarkup") return null;
  const value = payload.text ?? payload.caption;
  return typeof value === "string" ? value : null;
}

function normalizeChatId(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return value.trim();
  return null;
}

function normalizeMessageId(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return null;
}

function extractResponseMessageId(response: unknown) {
  const root = response as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return null;
  const direct = normalizeMessageId(root.message_id);
  if (direct) return direct;
  const nested = root.result;
  if (!nested || typeof nested !== "object") return null;
  return normalizeMessageId((nested as Record<string, unknown>).message_id);
}
