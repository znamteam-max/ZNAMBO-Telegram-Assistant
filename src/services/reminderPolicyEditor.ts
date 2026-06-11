import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { auditLog, plannerItems, reminderPolicies, reminders } from "@/db/schema";
import { getLatestAuditByAction, writeAudit } from "@/db/queries/audit";
import { nextGridSlot } from "@/domain/reminderPolicySchedule";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";

export async function editReminderPolicy(params: {
  userId: string;
  policyId: string;
  status?: "active" | "paused" | "cancelled";
  intervalMinutes?: number;
  basePriority?: number;
  now?: Date;
  recordVersion?: boolean;
}) {
  const now = params.now ?? new Date();
  const updated = await getDb().transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(reminderPolicies)
      .where(
        and(eq(reminderPolicies.id, params.policyId), eq(reminderPolicies.userId, params.userId)),
      )
      .limit(1);
    if (!before) return null;

    const status = params.status ?? before.status;
    const intervalMinutes = params.intervalMinutes ?? before.intervalMinutes;
    const nextFireAt =
      status === "active"
        ? computeNextFire({ policy: before, intervalMinutes, now })
        : null;
    const metadataPatch =
      params.basePriority === undefined
        ? {}
        : { basePriority: clampPriority(params.basePriority), priorityUpdatedAt: now.toISOString() };
    const [after] = await tx
      .update(reminderPolicies)
      .set({
        status,
        intervalMinutes,
        nextFireAt,
        metadata: sql`${reminderPolicies.metadata} || ${JSON.stringify(metadataPatch)}::jsonb`,
        updatedAt: now,
      })
      .where(
        and(eq(reminderPolicies.id, params.policyId), eq(reminderPolicies.userId, params.userId)),
      )
      .returning();
    if (!after) return null;

    await tx
      .update(reminders)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(reminders.policyId, params.policyId),
          inArray(reminders.status, ["pending", "claimed"]),
        ),
      );
    if (params.basePriority !== undefined && after.itemId) {
      await tx
        .update(plannerItems)
        .set({ priority: clampPriority(params.basePriority), updatedAt: now })
        .where(and(eq(plannerItems.id, after.itemId), eq(plannerItems.userId, params.userId)));
    }
    if (params.recordVersion !== false) {
      await tx.insert(auditLog).values({
        userId: params.userId,
        action: "assistant.reminder_policy_version",
        entityType: "reminder_policy",
        entityId: after.id,
        details: {
          changeType: params.status
            ? `status_${params.status}`
            : params.intervalMinutes
              ? "interval"
              : "priority",
          beforeSnapshot: serializePolicy(before),
          afterSnapshot: serializePolicy(after),
        },
      });
    }
    return after;
  });

  if (updated?.status === "active" && updated.nextFireAt) {
    await materializeNextPolicyReminder(updated, updated.nextFireAt, { now });
  }
  return updated;
}

export async function undoLastReminderPolicyEdit(userId: string) {
  const version = await getLatestAuditByAction({
    userId,
    action: "assistant.reminder_policy_version",
  });
  const before = version?.details?.beforeSnapshot as
    | {
        id?: string;
        status?: "active" | "paused" | "cancelled";
        intervalMinutes?: number | null;
        metadata?: Record<string, unknown>;
      }
    | undefined;
  if (!version || !before?.id || !before.status) return null;
  const restored = await editReminderPolicy({
    userId,
    policyId: before.id,
    status: before.status,
    intervalMinutes: before.intervalMinutes ?? undefined,
    basePriority: Number(before.metadata?.basePriority ?? 3),
    recordVersion: false,
  });
  if (restored) {
    await writeAudit({
      userId,
      action: "assistant.reminder_policy_version_undone",
      entityType: "reminder_policy",
      entityId: restored.id,
      details: { versionId: version.id },
    });
  }
  return restored;
}

function computeNextFire(params: {
  policy: typeof reminderPolicies.$inferSelect;
  intervalMinutes: number | null;
  now: Date;
}) {
  if (
    params.intervalMinutes &&
    ["interval_window", "nag_until_ack"].includes(params.policy.policyType)
  ) {
    return nextGridSlot({
      anchor: params.policy.startsAt ?? params.now,
      intervalMinutes: params.intervalMinutes,
      after: params.now,
      endsAt: params.policy.endsAt,
      inclusiveEnd: params.policy.windowEndInclusive,
    });
  }
  if (params.policy.nextFireAt && params.policy.nextFireAt > params.now) {
    return params.policy.nextFireAt;
  }
  if (params.policy.startsAt && params.policy.startsAt > params.now) return params.policy.startsAt;
  return new Date(params.now.getTime() + 60 * 1000);
}

function serializePolicy(policy: typeof reminderPolicies.$inferSelect) {
  return {
    id: policy.id,
    status: policy.status,
    intervalMinutes: policy.intervalMinutes,
    nextFireAt: policy.nextFireAt?.toISOString() ?? null,
    metadata: policy.metadata,
  };
}

function clampPriority(value: number) {
  return Math.max(1, Math.min(5, Math.round(value)));
}
