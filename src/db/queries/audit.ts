import { getDb } from "../client";
import { auditLog } from "../schema";

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
