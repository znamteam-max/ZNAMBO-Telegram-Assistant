import { recordAssistantConversationMessage } from "@/services/conversation";

import type { BotContext } from "./context";

type ReplyOptions = Parameters<BotContext["reply"]>[1];

export async function replyAndRecord(ctx: BotContext, text: string, options?: ReplyOptions) {
  const message = await ctx.reply(text, options);
  await recordAssistantConversationMessage({
    userId: ctx.owner?.id,
    telegramMessageId: ctx.dbMessageId,
    text,
    messageType: "telegram_send",
    metadata: {
      journalVersion: 1,
      telegramOutboundMessageId: "message_id" in message ? message.message_id : null,
      lifecycle: "sent",
      source: "replyAndRecord",
    },
  });
  return message;
}
