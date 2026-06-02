import { getDb } from "../client";
import { auditLog } from "../schema";
import { and, desc, eq } from "drizzle-orm";

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
