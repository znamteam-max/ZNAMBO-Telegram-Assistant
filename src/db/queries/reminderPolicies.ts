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
  windowEndInclusive?: boolean;
  catchUpMode?: string;
  onWindowEnd?: string;
  quietHours?: Record<string, unknown> | null;
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
      windowEndInclusive: input.windowEndInclusive ?? true,
      catchUpMode: input.catchUpMode ?? "one_immediate_then_resume",
      onWindowEnd: input.onWindowEnd ?? "expire_silently",
      quietHours: input.quietHours,
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

export async function listReminderPoliciesByStatus(userId: string, status: string, limit = 100) {
  return getDb()
    .select()
    .from(reminderPolicies)
    .where(and(eq(reminderPolicies.userId, userId), eq(reminderPolicies.status, status)))
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

export async function listActiveReminderPoliciesByCategory(
  userId: string,
  category: string,
  limit = 100,
) {
  const categories =
    category === "car"
      ? ["car", "recurring_car"]
      : category === "finance"
        ? ["finance", "recurring_finance"]
        : [category];
  return getDb()
    .select()
    .from(reminderPolicies)
    .where(
      and(
        eq(reminderPolicies.userId, userId),
        eq(reminderPolicies.status, "active"),
        inArray(reminderPolicies.category, categories),
      ),
    )
    .orderBy(sql`${reminderPolicies.nextFireAt} asc nulls last`, asc(reminderPolicies.title))
    .limit(limit);
}

export async function listActivePoliciesForReconciliation(limit = 200) {
  return getDb()
    .select()
    .from(reminderPolicies)
    .where(eq(reminderPolicies.status, "active"))
    .orderBy(sql`${reminderPolicies.nextFireAt} asc nulls first`, asc(reminderPolicies.createdAt))
    .limit(limit);
}

export async function updateReminderPolicy(params: {
  policyId: string;
  userId: string;
  status?: string;
  nextFireAt?: Date | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  title?: string;
  category?: string;
  policyType?: string;
  recurrenceRule?: string | null;
  intervalMinutes?: number | null;
  requireAck?: boolean;
  windowEndInclusive?: boolean;
  catchUpMode?: string;
  onWindowEnd?: string;
  quietHours?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}) {
  const [row] = await getDb()
    .update(reminderPolicies)
    .set({
      ...(params.status ? { status: params.status } : {}),
      ...(params.nextFireAt !== undefined ? { nextFireAt: params.nextFireAt } : {}),
      ...(params.startsAt !== undefined ? { startsAt: params.startsAt } : {}),
      ...(params.endsAt !== undefined ? { endsAt: params.endsAt } : {}),
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.category !== undefined ? { category: params.category } : {}),
      ...(params.policyType !== undefined ? { policyType: params.policyType } : {}),
      ...(params.recurrenceRule !== undefined ? { recurrenceRule: params.recurrenceRule } : {}),
      ...(params.intervalMinutes !== undefined ? { intervalMinutes: params.intervalMinutes } : {}),
      ...(params.requireAck !== undefined ? { requireAck: params.requireAck } : {}),
      ...(params.windowEndInclusive !== undefined
        ? { windowEndInclusive: params.windowEndInclusive }
        : {}),
      ...(params.catchUpMode !== undefined ? { catchUpMode: params.catchUpMode } : {}),
      ...(params.onWindowEnd !== undefined ? { onWindowEnd: params.onWindowEnd } : {}),
      ...(params.quietHours !== undefined ? { quietHours: params.quietHours } : {}),
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

export async function updatePoliciesPriorityForItem(params: {
  userId: string;
  itemId: string;
  priority: number;
}) {
  await getDb()
    .update(reminderPolicies)
    .set({
      metadata: sql`${reminderPolicies.metadata} || ${JSON.stringify({
        basePriority: Math.max(1, Math.min(5, params.priority)),
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(reminderPolicies.userId, params.userId), eq(reminderPolicies.itemId, params.itemId)),
    );
}

export async function expirePolicyAndCancelFutureReminders(params: {
  policyId: string;
  userId: string;
  expiredAt: Date;
}) {
  await getDb().transaction(async (tx) => {
    await tx
      .update(reminderPolicies)
      .set({
        status: "expired",
        nextFireAt: null,
        metadata: sql`${reminderPolicies.metadata} || ${JSON.stringify({
          expiredAt: params.expiredAt.toISOString(),
          expirationReason: "window_ended",
        })}::jsonb`,
        updatedAt: params.expiredAt,
      })
      .where(
        and(eq(reminderPolicies.id, params.policyId), eq(reminderPolicies.userId, params.userId)),
      );
    await tx
      .update(reminders)
      .set({ status: "cancelled", updatedAt: params.expiredAt })
      .where(
        and(
          eq(reminders.policyId, params.policyId),
          inArray(reminders.status, ["pending", "claimed"]),
        ),
      );
  });
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

export async function getPolicySlotState(policyId: string, scheduledFor: Date) {
  const [row] = await getDb()
    .select({
      occurrence: reminderPolicyOccurrences,
      reminder: reminders,
    })
    .from(reminderPolicyOccurrences)
    .leftJoin(reminders, eq(reminderPolicyOccurrences.reminderId, reminders.id))
    .where(
      and(
        eq(reminderPolicyOccurrences.policyId, policyId),
        eq(reminderPolicyOccurrences.scheduledFor, scheduledFor),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getPendingReminderForPolicy(policyId: string) {
  const [row] = await getDb()
    .select()
    .from(reminders)
    .where(and(eq(reminders.policyId, policyId), inArray(reminders.status, ["pending", "claimed"])))
    .orderBy(asc(reminders.scheduledAt))
    .limit(1);
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
    .set(skipped ? { status: "skipped", skippedAt: now } : { status: "acked", ackedAt: now })
    .where(eq(reminderPolicyOccurrences.reminderId, reminderId));
}

export async function getPolicyForReminder(reminderId: string) {
  const [row] = await getDb()
    .select({
      policy: reminderPolicies,
      reminder: reminders,
      occurrence: reminderPolicyOccurrences,
    })
    .from(reminders)
    .innerJoin(reminderPolicies, eq(reminders.policyId, reminderPolicies.id))
    .leftJoin(reminderPolicyOccurrences, eq(reminderPolicyOccurrences.reminderId, reminders.id))
    .where(eq(reminders.id, reminderId))
    .limit(1);
  return row ?? null;
}

export async function getLatestPolicyDebug(userId: string, policyId?: string | null) {
  const conditions = [
    eq(reminderPolicies.userId, userId),
    ...(policyId ? [eq(reminderPolicies.id, policyId)] : []),
  ];
  const [policy] = await getDb()
    .select()
    .from(reminderPolicies)
    .where(and(...conditions))
    .orderBy(desc(reminderPolicies.updatedAt))
    .limit(1);
  if (!policy) return null;

  const [occurrence] = await getDb()
    .select({
      occurrence: reminderPolicyOccurrences,
      reminder: reminders,
    })
    .from(reminderPolicyOccurrences)
    .leftJoin(reminders, eq(reminderPolicyOccurrences.reminderId, reminders.id))
    .where(eq(reminderPolicyOccurrences.policyId, policy.id))
    .orderBy(desc(reminderPolicyOccurrences.scheduledFor))
    .limit(1);
  return { policy, occurrence: occurrence ?? null };
}

export async function getReminderPolicyHealthStats() {
  const rows = await getDb().execute(sql`
    select
      count(*) filter (where p.status = 'active')::int as "activePolicyCount",
      count(*) filter (
        where p.status = 'active'
          and (
            p.next_fire_at is null
            or not exists (
              select 1
              from "assistant"."reminders" r
              where r.policy_id = p.id
                and r.status in ('pending', 'claimed')
            )
          )
      )::int as "policiesMissingNextReminder"
    from "assistant"."reminder_policies" p
  `);
  return (
    (rows[0] as { activePolicyCount: number; policiesMissingNextReminder: number } | undefined) ?? {
      activePolicyCount: 0,
      policiesMissingNextReminder: 0,
    }
  );
}
