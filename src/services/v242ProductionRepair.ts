import { and, eq, inArray, sql } from "drizzle-orm";

import { rememberAgentAction } from "@/agent/state/actionHistory";
import { getDb } from "@/db/client";
import { auditLog, plannerItems, reminderPolicies, reminders } from "@/db/schema";

export async function previewV242ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const [candidateItems, policies] = await Promise.all([
    getDb()
      .select()
      .from(plannerItems)
      .where(
        and(
          eq(plannerItems.userId, params.userId),
          eq(plannerItems.status, "active"),
          sql`(
            ${plannerItems.title} ~* '^Напоминания? о.*Дрик'
            or ${plannerItems.title} ~* '^Напоминания? о занятии.*(Central|Централ).*Парк'
          )`,
        ),
      ),
    getDb()
      .select()
      .from(reminderPolicies)
      .where(
        and(
          eq(reminderPolicies.userId, params.userId),
          eq(reminderPolicies.status, "active"),
          sql`(
            (
              ${reminderPolicies.title} ~* 'Дрик'
              and (
                (
                  ${reminderPolicies.endsAt} is not null
                  and ${reminderPolicies.endsAt} < ${now.toISOString()}::timestamptz
                )
                or (
                  ${reminderPolicies.intervalMinutes} is not null
                  and ${reminderPolicies.policyType} not in ('interval_window', 'nag_until_ack')
                )
              )
            )
            or
            ${reminderPolicies.title} ~* '^Напоминания? о занятии.*(Central|Централ).*Парк'
          )`,
        ),
      ),
  ]);
  const candidateItemIds = candidateItems.map((item) => item.id);
  const linkedPolicies = candidateItemIds.length
    ? await getDb()
        .select({ itemId: reminderPolicies.itemId })
        .from(reminderPolicies)
        .where(
          and(
            eq(reminderPolicies.userId, params.userId),
            inArray(reminderPolicies.itemId, candidateItemIds),
          ),
        )
    : [];
  const linkedItemIds = new Set(
    linkedPolicies
      .map((policy) => policy.itemId)
      .filter((itemId): itemId is string => Boolean(itemId)),
  );
  const items = candidateItems.filter(
    (item) => /(?:central|централ).*парк/i.test(item.title) || !linkedItemIds.has(item.id),
  );
  const policyIds = policies.map((policy) => policy.id);
  const itemIds = items.map((item) => item.id);
  const affectedReminders =
    policyIds.length || itemIds.length
      ? await getDb()
          .select()
          .from(reminders)
          .where(
            and(
              eq(reminders.userId, params.userId),
              sql`(
                ${policyIds.length ? inArray(reminders.policyId, policyIds) : sql`false`}
                or
                ${itemIds.length ? inArray(reminders.plannerItemId, itemIds) : sql`false`}
              )`,
            ),
          )
      : [];
  const shifted = affectedReminders.filter((reminder) => {
    const minute = reminder.scheduledAt.getUTCMinutes();
    return minute === 14 || minute === 44 || minute === 45;
  });

  return {
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      startAt: item.startAt,
      dueAt: item.dueAt,
    })),
    policies: policies.map((policy) => ({
      id: policy.id,
      title: policy.title,
      policyType: policy.policyType,
      startsAt: policy.startsAt,
      endsAt: policy.endsAt,
      nextFireAt: policy.nextFireAt,
    })),
    affectedReminderCount: affectedReminders.length,
    futureReminderIds: affectedReminders
      .filter(
        (reminder) =>
          ["pending", "claimed"].includes(reminder.status) && reminder.scheduledAt >= now,
      )
      .map((reminder) => reminder.id),
    shiftedReminderIds: shifted.map((reminder) => reminder.id),
  };
}

export async function applyV242ProductionRepair(params: {
  userId: string;
  sourceMessageId?: string | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const preview = await previewV242ProductionRepair({
    userId: params.userId,
    now,
  });
  const itemIds = preview.items.map((item) => item.id);
  const policyIds = preview.policies.map((policy) => policy.id);
  const reminderIds = preview.futureReminderIds;

  await getDb().transaction(async (tx) => {
    if (itemIds.length) {
      await tx
        .update(plannerItems)
        .set({
          status: "cancelled",
          cancelledAt: now,
          archivedAt: now,
          metadata: sql`${plannerItems.metadata} || ${JSON.stringify({
            mutationSource: "admin_repair",
            repairVersion: "2.4.2",
            archiveReason: "partial_or_generic_reminder_record",
          })}::jsonb`,
          updatedAt: now,
        })
        .where(and(eq(plannerItems.userId, params.userId), inArray(plannerItems.id, itemIds)));
    }
    if (policyIds.length) {
      await tx
        .update(reminderPolicies)
        .set({
          status: "expired",
          nextFireAt: null,
          metadata: sql`${reminderPolicies.metadata} || ${JSON.stringify({
            mutationSource: "admin_repair",
            repairVersion: "2.4.2",
            expirationReason: "expired_interval_window",
          })}::jsonb`,
          updatedAt: now,
        })
        .where(
          and(eq(reminderPolicies.userId, params.userId), inArray(reminderPolicies.id, policyIds)),
        );
    }
    if (reminderIds.length) {
      await tx
        .update(reminders)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(reminders.userId, params.userId), inArray(reminders.id, reminderIds)));
    }
    await tx.insert(auditLog).values({
      userId: params.userId,
      action: "assistant.v242_production_repair",
      entityType: "planner_item",
      details: {
        mutationSource: "admin_repair",
        repairVersion: "2.4.2",
        archivedItemIds: itemIds,
        expiredPolicyIds: policyIds,
        cancelledReminderIds: reminderIds,
      },
    });
  });

  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "cleanup_garbage",
    input: { repairVersion: "2.4.2", mode: "production_reminder_semantics" },
    output: {
      cancelledItemIds: itemIds,
      expiredPolicyIds: policyIds,
      cancelledReminderIds: reminderIds,
    },
    undoPayload: {
      items: preview.items.map((item) => ({
        id: item.id,
        status: "active",
        completedAt: null,
      })),
    },
  });

  return {
    preview,
    archivedItemIds: itemIds,
    expiredPolicyIds: policyIds,
    cancelledReminderIds: reminderIds,
  };
}
