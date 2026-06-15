import { getDb } from "../client";
import { auditLog } from "../schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export async function writeAudit(params: {
  userId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
}) {
  await getDb()
    .insert(auditLog)
    .values({
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      details: params.details ?? {},
    });
}

export async function getLatestAuditByAction(params: { userId: string; action: string }) {
  const [row] = await getDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, params.userId), eq(auditLog.action, params.action)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getLatestAuditByActions(params: { userId: string; actions: string[] }) {
  if (!params.actions.length) return null;
  const [row] = await getDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, params.userId), inArray(auditLog.action, params.actions)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getLatestAiAuditStatus(params?: { succeeded?: boolean }) {
  const conditions = [
    inArray(auditLog.action, ["assistant.agent_decision_trace", "assistant.ai_health"]),
    sql`${auditLog.details}->>'aiCalled' = 'true'`,
  ];
  if (typeof params?.succeeded === "boolean") {
    conditions.push(sql`${auditLog.details}->>'aiSucceeded' = ${String(params.succeeded)}`);
  }
  const [row] = await getDb()
    .select()
    .from(auditLog)
    .where(
      and(...conditions),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getLatestAuditByActionGlobal(action: string) {
  const [row] = await getDb()
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, action))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getLatestPlannerGuardBlock() {
  const [row] = await getDb()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "assistant.agent_decision_trace"),
        sql`${auditLog.details}->>'finalAction' like 'blocked_by_%'`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row ?? null;
}

export async function listRecentAuditLogs(params: {
  userId: string;
  since?: Date | null;
  limit?: number;
}) {
  const conditions = [eq(auditLog.userId, params.userId)];
  if (params.since) {
    conditions.push(sql`${auditLog.createdAt} >= ${params.since.toISOString()}::timestamptz`);
  }
  return getDb()
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.max(1, Math.min(params.limit ?? 30, 200)));
}
