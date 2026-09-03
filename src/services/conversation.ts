import { and, desc, eq, sql } from "drizzle-orm";

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

export async function updateIncomingConversationTranscript(params: {
  telegramMessageId: string;
  transcript: string;
}) {
  const [row] = await getDb()
    .update(conversationMessages)
    .set({ transcript: params.transcript })
    .where(
      and(
        eq(conversationMessages.telegramMessageId, params.telegramMessageId),
        eq(conversationMessages.role, "user"),
      ),
    )
    .returning();
  return row ?? null;
}

export async function recordAssistantConversationMessage(params: {
  userId?: string | null;
  telegramMessageId?: string | null;
  text?: string | null;
  summary?: string | null;
  messageType?: string;
  metadata?: Record<string, unknown>;
}) {
  if (!params.userId) return null;
  const messageType = params.messageType ?? "text";
  const metadata = params.metadata ?? {};
  const outboundMessageId = normalizeOutboundMessageId(
    metadata.telegramOutboundMessageId ?? metadata.telegramMessageId,
  );

  // replyAndRecord and the global Telegram API transformer can observe the same send.
  // Keep one durable row per actual Telegram send while still letting the transformer
  // capture direct ctx.reply()/bot.api.sendMessage() calls that bypass replyAndRecord.
  if (messageType === "telegram_send" && outboundMessageId) {
    const [existing] = await getDb()
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.userId, params.userId),
          eq(conversationMessages.role, "assistant"),
          eq(conversationMessages.messageType, "telegram_send"),
          sql`coalesce(${conversationMessages.metadata}->>'telegramOutboundMessageId', ${conversationMessages.metadata}->>'telegramMessageId') = ${outboundMessageId}`,
        ),
      )
      .orderBy(desc(conversationMessages.createdAt))
      .limit(1);
    if (existing) {
      if (params.telegramMessageId && !existing.telegramMessageId) {
        const [correlated] = await getDb()
          .update(conversationMessages)
          .set({ telegramMessageId: params.telegramMessageId })
          .where(eq(conversationMessages.id, existing.id))
          .returning();
        return correlated ?? existing;
      }
      return existing;
    }
  }

  const [row] = await getDb()
    .insert(conversationMessages)
    .values({
      userId: params.userId,
      telegramMessageId: params.telegramMessageId,
      role: "assistant",
      messageType,
      text: params.text ?? null,
      summary: params.summary,
      metadata,
    })
    .returning();
  return row ?? null;
}

export async function listRecentConversationMessages(userId: string, limit = 12) {
  return getDb()
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.userId, userId),
        sql`${conversationMessages.messageType} not in ('telegram_edit', 'telegram_delete')`,
      ),
    )
    .orderBy(desc(conversationMessages.createdAt))
    .limit(limit);
}

export async function listConversationMessagesForExport(params: {
  userId: string;
  since?: Date | null;
  limit?: number;
}) {
  const conditions = [eq(conversationMessages.userId, params.userId)];
  if (params.since) {
    conditions.push(
      sql`${conversationMessages.createdAt} >= ${params.since.toISOString()}::timestamptz`,
    );
  }
  return getDb()
    .select()
    .from(conversationMessages)
    .where(and(...conditions))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(Math.max(1, Math.min(params.limit ?? 5000, 5000)));
}

function normalizeOutboundMessageId(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}
