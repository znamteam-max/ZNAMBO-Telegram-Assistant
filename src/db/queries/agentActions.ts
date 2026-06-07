import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../client";
import { agentActions, type AgentAction } from "../schema";

export async function recordAgentAction(params: {
  userId?: string | null;
  sourceMessageId?: string | null;
  actionType: string;
  status?: "pending" | "completed" | "cancelled" | "failed" | "noop" | "undone";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  undoPayload?: Record<string, unknown>;
}): Promise<AgentAction | null> {
  const [row] = await getDb()
    .insert(agentActions)
    .values({
      userId: params.userId,
      sourceMessageId: params.sourceMessageId,
      actionType: params.actionType,
      status: params.status ?? "completed",
      input: params.input ?? {},
      output: params.output ?? {},
      undoPayload: params.undoPayload ?? {},
    })
    .returning();

  return row ?? null;
}

export async function getAgentActionById(params: {
  userId: string;
  actionId: string;
}): Promise<AgentAction | null> {
  const [row] = await getDb()
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.userId, params.userId), eq(agentActions.id, params.actionId)))
    .limit(1);
  return row ?? null;
}

export async function updateAgentAction(params: {
  userId: string;
  actionId: string;
  status: string;
  output?: Record<string, unknown>;
  undoPayload?: Record<string, unknown>;
}) {
  const [row] = await getDb()
    .update(agentActions)
    .set({
      status: params.status,
      output: params.output ?? {},
      undoPayload: params.undoPayload ?? {},
    })
    .where(and(eq(agentActions.userId, params.userId), eq(agentActions.id, params.actionId)))
    .returning();
  return row ?? null;
}

export async function getLatestAgentAction(params: {
  userId: string;
  actionType?: string | null;
}): Promise<AgentAction | null> {
  const conditions = [eq(agentActions.userId, params.userId)];
  if (params.actionType) conditions.push(eq(agentActions.actionType, params.actionType));

  const [row] = await getDb()
    .select()
    .from(agentActions)
    .where(and(...conditions))
    .orderBy(desc(agentActions.createdAt))
    .limit(1);

  return row ?? null;
}
