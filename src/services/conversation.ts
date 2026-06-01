import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { conversationMessages } from "@/db/schema";

export async function recordIncomingConversationMessage(params: {
  userId?: string | null;
  telegramMessageId?: string | null;
  messageType: string;
  text?: string | null;
  transcript?: string | null;
  metadata?: Record<string, unknown>;
}) {
  if (!params.userId && !params.telegramMessageId) return null;
  const [row] = await getDb()
    .insert(conversationMessages)
    .values({
      userId: params.userId,
      telegramMessageId: params.telegramMessageId,
      role: "user",
      messageType: params.messageType,
      text: params.text,
      transcript: params.transcript,
      metadata: params.metadata ?? {},
    })
    .returning();
  return row ?? null;
}

export async function recordAssistantConversationMessage(params: {
  userId?: string | null;
  telegramMessageId?: string | null;
  text: string;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}) {
  if (!params.userId) return null;
  const [row] = await getDb()
    .insert(conversationMessages)
    .values({
      userId: params.userId,
      telegramMessageId: params.telegramMessageId,
      role: "assistant",
      messageType: "text",
      text: params.text,
      summary: params.summary,
      metadata: params.metadata ?? {},
    })
    .returning();
  return row ?? null;
}

export async function listRecentConversationMessages(userId: string, limit = 12) {
  return getDb()
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.userId, userId))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(limit);
}
