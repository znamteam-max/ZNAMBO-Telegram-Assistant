import {
  listActiveMessages,
  markTelegramMessageStatus,
  registerTelegramBotMessage,
} from "@/db/queries/telegramMessageRegistry";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/db/queries/audit";

import { getBot } from "@/bot/createBot";

export type TelegramLifecycleApi = {
  deleteMessage(chatId: string, messageId: number): Promise<unknown>;
  editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    options: { reply_markup: { inline_keyboard: never[] } },
  ): Promise<unknown>;
};

export async function registerBotMessage(params: {
  userId: string;
  chatId: string;
  messageId: number;
  purpose: string;
  relatedItemId?: string | null;
  relatedReminderId?: string | null;
  deleteAfter?: Date | null;
  metadata?: Record<string, unknown>;
}) {
  return registerTelegramBotMessage(params);
}

export async function deleteMessageSafe(params: {
  chatId: string;
  messageId: number;
  api?: TelegramLifecycleApi;
}) {
  const api = params.api ?? (getBot().api as unknown as TelegramLifecycleApi);
  try {
    await api.deleteMessage(params.chatId, params.messageId);
    await markTelegramMessageStatus(params.chatId, params.messageId, "deleted");
    return true;
  } catch (error) {
    logger.warn("Telegram message delete failed", {
      chatId: params.chatId,
      messageId: params.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    await removeKeyboardSafe({ ...params, api });
    await markTelegramMessageStatus(params.chatId, params.messageId, "failed_to_delete");
    return false;
  }
}

export async function deleteMessagesSafe(params: {
  chatId: string;
  messageIds: number[];
  api?: TelegramLifecycleApi;
}) {
  const results = [];
  for (const messageId of params.messageIds) {
    results.push(await deleteMessageSafe({ ...params, messageId }));
  }
  return results;
}

export async function markMessageStale(chatId: string, messageId: number) {
  return markTelegramMessageStatus(chatId, messageId, "stale");
}

export async function removeKeyboardSafe(params: {
  chatId: string;
  messageId: number;
  api?: TelegramLifecycleApi;
}) {
  const api = params.api ?? (getBot().api as unknown as TelegramLifecycleApi);
  try {
    await api.editMessageReplyMarkup(params.chatId, params.messageId, {
      reply_markup: { inline_keyboard: [] },
    });
    await markTelegramMessageStatus(params.chatId, params.messageId, "stale");
    return true;
  } catch {
    return false;
  }
}

export async function cleanupMessagesForItem(params: {
  userId: string;
  chatId: string;
  itemId: string;
  api?: TelegramLifecycleApi;
}) {
  const messages = await listActiveMessages({
    userId: params.userId,
    chatId: params.chatId,
    relatedItemId: params.itemId,
  });
  const result = await deleteMessagesSafe({
    chatId: params.chatId,
    messageIds: messages.map((message) => message.messageId),
    api: params.api,
  });
  await writeCleanupAudit({
    userId: params.userId,
    itemId: params.itemId,
    operation: "cleanup_messages_for_item",
    messageCount: messages.length,
  });
  return result;
}

export async function cleanupTransientMessages(params: {
  userId: string;
  chatId: string;
  api?: TelegramLifecycleApi;
}) {
  const messages = await listActiveMessages({
    userId: params.userId,
    chatId: params.chatId,
    purposes: ["item_menu", "reminder", "followup", "confirmation", "transient_status"],
  });
  const result = await deleteMessagesSafe({
    chatId: params.chatId,
    messageIds: messages.map((message) => message.messageId),
    api: params.api,
  });
  await writeCleanupAudit({
    userId: params.userId,
    operation: "cleanup_transient_messages",
    messageCount: messages.length,
  });
  return result;
}

export async function cleanupOldDashboards(params: {
  userId: string;
  chatId: string;
  api?: TelegramLifecycleApi;
}) {
  const messages = await listActiveMessages({
    userId: params.userId,
    chatId: params.chatId,
    purposes: ["dashboard"],
  });
  const old = messages.slice(0, -1);
  return deleteMessagesSafe({
    chatId: params.chatId,
    messageIds: old.map((message) => message.messageId),
    api: params.api,
  });
}

export async function cleanupAfterCallback(params: {
  userId: string;
  chatId: string;
  messageId?: number | null;
  relatedItemId?: string | null;
  api?: TelegramLifecycleApi;
}) {
  if (params.messageId) {
    await deleteMessageSafe({
      chatId: params.chatId,
      messageId: params.messageId,
      api: params.api,
    });
  }
  if (params.relatedItemId) {
    await cleanupMessagesForItem({
      userId: params.userId,
      chatId: params.chatId,
      itemId: params.relatedItemId,
      api: params.api,
    });
  }
  await writeCleanupAudit({
    userId: params.userId,
    itemId: params.relatedItemId,
    operation: "cleanup_after_callback",
    messageCount: params.messageId ? 1 : 0,
  });
}

async function writeCleanupAudit(params: {
  userId: string;
  itemId?: string | null;
  operation: string;
  messageCount: number;
}) {
  await writeAudit({
    userId: params.userId,
    action: "assistant.telegram_message_cleanup",
    entityType: params.itemId ? "planner_item" : "telegram_message",
    entityId: params.itemId,
    details: {
      mutationSource: "telegram_message_cleanup",
      plannerMutationAllowed: false,
      operation: params.operation,
      messageCount: params.messageCount,
    },
  }).catch((error) => {
    logger.warn("Telegram cleanup audit failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
