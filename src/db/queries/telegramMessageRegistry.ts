import { and, asc, eq, inArray, lt } from "drizzle-orm";

import { getDb } from "../client";
import { telegramMessageRegistry } from "../schema";

export async function registerTelegramBotMessage(params: {
  userId: string;
  chatId: string;
  messageId: number;
  purpose: string;
  relatedItemId?: string | null;
  relatedReminderId?: string | null;
  deleteAfter?: Date | null;
  metadata?: Record<string, unknown>;
}) {
  const [row] = await getDb()
    .insert(telegramMessageRegistry)
    .values(params)
    .onConflictDoUpdate({
      target: [telegramMessageRegistry.chatId, telegramMessageRegistry.messageId],
      set: {
        purpose: params.purpose,
        relatedItemId: params.relatedItemId,
        relatedReminderId: params.relatedReminderId,
        deleteAfter: params.deleteAfter,
        metadata: params.metadata ?? {},
        status: "active",
        updatedAt: new Date(),
      },
    })
    .returning();
  return row ?? null;
}

export async function listActiveMessages(params: {
  userId: string;
  chatId: string;
  purposes?: string[];
  relatedItemId?: string;
  expiredBefore?: Date;
  limit?: number;
}) {
  const conditions = [
    eq(telegramMessageRegistry.userId, params.userId),
    eq(telegramMessageRegistry.chatId, params.chatId),
    eq(telegramMessageRegistry.status, "active"),
  ];
  if (params.purposes?.length) {
    conditions.push(inArray(telegramMessageRegistry.purpose, params.purposes));
  }
  if (params.relatedItemId) {
    conditions.push(eq(telegramMessageRegistry.relatedItemId, params.relatedItemId));
  }
  if (params.expiredBefore) {
    conditions.push(lt(telegramMessageRegistry.deleteAfter, params.expiredBefore));
  }
  return getDb()
    .select()
    .from(telegramMessageRegistry)
    .where(and(...conditions))
    .orderBy(asc(telegramMessageRegistry.createdAt))
    .limit(params.limit ?? 100);
}

export async function markTelegramMessageStatus(
  chatId: string,
  messageId: number,
  status: string,
) {
  const [row] = await getDb()
    .update(telegramMessageRegistry)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(telegramMessageRegistry.chatId, chatId),
        eq(telegramMessageRegistry.messageId, messageId),
      ),
    )
    .returning();
  return row ?? null;
}
