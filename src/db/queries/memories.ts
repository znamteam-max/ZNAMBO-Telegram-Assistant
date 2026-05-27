import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../client";
import { memories, plannerItems, reminders, telegramMessages, type Memory } from "../schema";

export async function listActiveMemories(userId: string, limit = 20): Promise<Memory[]> {
  return getDb()
    .select()
    .from(memories)
    .where(and(eq(memories.userId, userId), eq(memories.status, "active")))
    .orderBy(desc(memories.updatedAt))
    .limit(limit);
}

export async function deleteMemoryForUser(userId: string, memoryId: string): Promise<boolean> {
  const [memory] = await getDb()
    .update(memories)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(and(eq(memories.userId, userId), eq(memories.id, memoryId)))
    .returning({ id: memories.id });
  return Boolean(memory);
}

export async function exportOwnerData(userId: string) {
  const ownerMemories = await getDb().select().from(memories).where(eq(memories.userId, userId));
  const items = await getDb().select().from(plannerItems).where(eq(plannerItems.userId, userId));
  const ownerReminders = await getDb().select().from(reminders).where(eq(reminders.userId, userId));
  const messages = await getDb()
    .select()
    .from(telegramMessages)
    .where(eq(telegramMessages.userId, userId));
  return {
    exportedAt: new Date().toISOString(),
    plannerItems: items,
    reminders: ownerReminders,
    memories: ownerMemories,
    telegramMessages: messages.map((message) => ({
      id: message.id,
      messageType: message.messageType,
      text: message.text,
      transcript: message.transcript,
      createdAt: message.createdAt,
    })),
  };
}
