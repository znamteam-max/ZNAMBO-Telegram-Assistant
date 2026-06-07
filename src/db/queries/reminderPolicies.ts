import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../client";
import {
  reminderPolicies,
  reminderPolicyOccurrences,
  reminders,
  type ReminderPolicy,
} from "../schema";

export type CreateReminderPolicyInput = {
  userId: string;
  itemId?: string | null;
  title: string;
  category: string;
  policyType: string;
  timezone: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  nextFireAt?: Date | null;
  recurrenceRule?: string | null;
  intervalMinutes?: number | null;
  requireAck?: boolean;
  maxOccurrences?: number | null;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
};

export async function createReminderPolicyIfMissing(
  input: CreateReminderPolicyInput,
): Promise<ReminderPolicy> {
  const [existing] = await getDb()
    .select()
    .from(reminderPolicies)
    .where(
      and(
        eq(reminderPolicies.userId, input.userId),
        sql`${reminderPolicies.metadata}->>'idempotencyKey' = ${input.idempotencyKey}`,
      ),
    )
    .limit(1);
  if (existing) return existing;

  const [created] = await getDb()
    .insert(reminderPolicies)
    .values({
      userId: input.userId,
      itemId: input.itemId,
      title: input.title,
      category: input.category,
      policyType: input.policyType,
      timezone: input.timezone,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      nextFireAt: input.nextFireAt,
      recurrenceRule: input.recurrenceRule,
      intervalMinutes: input.intervalMinutes,
      requireAck: input.requireAck ?? false,
      maxOccurrences: input.maxOccurrences,
      metadata: { ...(input.metadata ?? {}), idempotencyKey: input.idempotencyKey },
    })
    .returning();
  if (!created) throw new Error("Reminder policy was not created");
  return created;
}

export async function getReminderPolicyById(policyId: string) {
  const [row] = await getDb()
    .select()
    .from(reminderPolicies)
    .where(eq(reminderPolicies.id, policyId))
    .limit(1);
  return row ?? null;
}

export async function listActiveReminderPolicies(userId: string, limit = 100) {
  return getDb()
    .select()
    .from(reminderPolicies)
    .where(and(eq(reminderPolicies.userId, userId), eq(reminderPolicies.status, "active")))
    .orderBy(sql`${reminderPolicies.nextFireAt} asc nulls last`, desc(reminderPolicies.createdAt))
    .limit(limit);
}

export async function listLongTermReminderPolicies(userId: string, limit = 100) {
  return getDb()
    .select()
    .from(reminderPolicies)
    .where(
      and(
        eq(reminderPolicies.userId, userId),
        eq(reminderPolicies.status, "active"),
        inArray(reminderPolicies.policyType, ["recurring", "long_term"]),
      ),
    )
    .orderBy(sql`${reminderPolicies.nextFireAt} asc nulls last`, asc(reminderPolicies.title))
    .limit(limit);
}

export async function updateReminderPolicy(params: {
  policyId: string;
  userId: string;
  status?: string;
  nextFireAt?: Date | null;
  metadata?: Record<string, unknown>;
}) {
  const [row] = await getDb()
    .update(reminderPolicies)
    .set({
      ...(params.status ? { status: params.status } : {}),
      ...(params.nextFireAt !== undefined ? { nextFireAt: params.nextFireAt } : {}),
      ...(params.metadata
        ? {
            metadata: sql`${reminderPolicies.metadata} || ${JSON.stringify(params.metadata)}::jsonb`,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(eq(reminderPolicies.id, params.policyId), eq(reminderPolicies.userId, params.userId)),
    )
    .returning();
  return row ?? null;
}

export async function stopPoliciesForItem(userId: string, itemId: string) {
  await getDb()
    .update(reminderPolicies)
    .set({ status: "completed", nextFireAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(reminderPolicies.userId, userId),
        eq(reminderPolicies.itemId, itemId),
        eq(reminderPolicies.status, "active"),
      ),
    );
}

export async function createPolicyOccurrence(params: {
  policyId: string;
  reminderId?: string | null;
  scheduledFor: Date;
  metadata?: Record<string, unknown>;
}) {
  const [row] = await getDb()
    .insert(reminderPolicyOccurrences)
    .values({
      policyId: params.policyId,
      reminderId: params.reminderId,
      scheduledFor: params.scheduledFor,
      metadata: params.metadata ?? {},
    })
    .onConflictDoNothing({
      target: [reminderPolicyOccurrences.policyId, reminderPolicyOccurrences.scheduledFor],
    })
    .returning();
  return row ?? null;
}

export async function attachOccurrenceReminder(params: {
  policyId: string;
  scheduledFor: Date;
  reminderId: string;
}) {
  await getDb()
    .update(reminderPolicyOccurrences)
    .set({ reminderId: params.reminderId })
    .where(
      and(
        eq(reminderPolicyOccurrences.policyId, params.policyId),
        eq(reminderPolicyOccurrences.scheduledFor, params.scheduledFor),
      ),
    );
}

export async function markPolicyOccurrenceDelivered(reminderId: string, deliveredAt = new Date()) {
  await getDb()
    .update(reminderPolicyOccurrences)
    .set({ status: "sent", deliveredAt })
    .where(eq(reminderPolicyOccurrences.reminderId, reminderId));
}

export async function markPolicyOccurrenceAcked(reminderId: string, skipped = false) {
  const now = new Date();
  await getDb()
    .update(reminderPolicyOccurrences)
    .set(
      skipped
        ? { status: "skipped", skippedAt: now }
        : { status: "acked", ackedAt: now },
    )
    .where(eq(reminderPolicyOccurrences.reminderId, reminderId));
}

export async function getPolicyForReminder(reminderId: string) {
  const [row] = await getDb()
    .select({ policy: reminderPolicies, reminder: reminders })
    .from(reminders)
    .innerJoin(reminderPolicies, eq(reminders.policyId, reminderPolicies.id))
    .where(eq(reminders.id, reminderId))
    .limit(1);
  return row ?? null;
}
