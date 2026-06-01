import { and, desc, eq, ilike, or } from "drizzle-orm";

import type { ActionPlan, ActionPlanItem } from "@/ai/schemas";
import { getDb } from "@/db/client";
import { conversationSummaries, memories, memoryFacts } from "@/db/schema";

export async function listRelevantMemoryFacts(params: {
  userId: string;
  query?: string;
  limit?: number;
}) {
  const limit = params.limit ?? 12;
  const query = params.query?.trim();
  if (query) {
    const terms = query
      .split(/\s+/)
      .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
      .filter((term) => term.length >= 4)
      .slice(0, 6);
    if (terms.length) {
      return getDb()
        .select()
        .from(memoryFacts)
        .where(
          and(
            eq(memoryFacts.userId, params.userId),
            eq(memoryFacts.status, "active"),
            or(...terms.map((term) => ilike(memoryFacts.content, `%${term}%`))),
          ),
        )
        .orderBy(desc(memoryFacts.updatedAt))
        .limit(limit);
    }
  }

  return getDb()
    .select()
    .from(memoryFacts)
    .where(and(eq(memoryFacts.userId, params.userId), eq(memoryFacts.status, "active")))
    .orderBy(desc(memoryFacts.updatedAt))
    .limit(limit);
}

export async function listRecentConversationSummaries(userId: string, limit = 4) {
  return getDb()
    .select()
    .from(conversationSummaries)
    .where(eq(conversationSummaries.userId, userId))
    .orderBy(desc(conversationSummaries.updatedAt))
    .limit(limit);
}

export async function storePlanMemoryFacts(params: {
  userId: string;
  sourceMessageId?: string | null;
  plan: ActionPlan;
}) {
  const candidates = [
    ...params.plan.memoryCandidates,
    ...params.plan.actions.flatMap((action) => action.memoryCandidates),
  ];
  if (!candidates.length) return;

  await getDb()
    .insert(memoryFacts)
    .values(
      candidates.map((memory) => ({
        userId: params.userId,
        category: memory.category,
        content: memory.content,
        source: "planner",
        status: "active",
        confidencePercent: 70,
        sourceMessageId: params.sourceMessageId,
        searchTags: memory.searchTags,
      })),
    )
    .onConflictDoNothing();

  await getDb()
    .insert(memories)
    .values(
      candidates.map((memory) => ({
        userId: params.userId,
        category: memory.category,
        content: memory.content,
        status: "active",
        sourceMessageId: params.sourceMessageId,
        searchTags: memory.searchTags,
      })),
    )
    .onConflictDoNothing();
}

export function summarizeActionForMemory(action: ActionPlanItem): string | null {
  if (action.actionType === "recurring_task" && action.recurrence?.repeatUntilAck) {
    return `Повторяющаяся задача: ${action.title}; время ${action.recurrence.timeLocal ?? "09:30"}; пока не подтверждено.`;
  }
  if (action.actionType === "training") {
    return `Тренировка: ${action.title}${action.description ? `; ${action.description}` : ""}.`;
  }
  return null;
}
