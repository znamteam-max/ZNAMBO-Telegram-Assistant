import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { planPolicySnooze } from "@/domain/reminderPolicySchedule";
import { findNextAvailableReminderSlot } from "@/services/reminderCollisionSpacing";
import { writeAudit } from "@/db/queries/audit";

import { getDb } from "../client";
import {
  plannerItems,
  reminderDeliveries,
  reminderPolicies,
  reminderPolicyOccurrences,
  reminders,
  type Reminder,
} from "../schema";

export type ClaimedReminder = Reminder;

export async function claimDueReminders(params: {
  now: Date;
  limit: number;
}): Promise<ClaimedReminder[]> {
  await spreadDueReminderCollisionsBeforeClaim(params.now);
  const nowIso = params.now.toISOString();
  const rows = await getDb().execute(sql`
    with due as (
      select r.id
      from "assistant"."reminders" r
      where r.status = 'pending'
        and r.scheduled_at <= ${nowIso}::timestamptz
        and not exists (
          select 1
          from "assistant"."reminder_policies" p
          where p.id = r.policy_id
            and p.snoozed_until > ${nowIso}::timestamptz
        )
        and not exists (
          select 1
          from "assistant"."planner_items" i
          where i.id = r.planner_item_id
            and i.snoozed_until > ${nowIso}::timestamptz
        )
      order by r.scheduled_at asc
      limit ${params.limit}
      for update skip locked
    )
    update "assistant"."reminders" as r
    set status = 'claimed',
        claimed_at = now(),
        attempt_count = r.attempt_count + 1,
        updated_at = now()
    from due
    where r.id = due.id
    returning
      r.id,
      r.user_id as "userId",
      r.planner_item_id as "plannerItemId",
      r.type,
      r.scheduled_at as "scheduledAt",
      r.status,
      r.claimed_at as "claimedAt",
      r.sent_at as "sentAt",
      r.telegram_message_id as "telegramMessageId",
      r.attempt_count as "attemptCount",
      r.last_error as "lastError",
      r.repeat_until_ack as "repeatUntilAck",
      r.acked_at as "ackedAt",
      r.parent_reminder_id as "parentReminderId",
      r.recurrence_key as "recurrenceKey",
      r.policy_id as "policyId",
      r.purpose,
      r.menu_type as "menuType",
      r.auto_delete_after_response as "autoDeleteAfterResponse",
      r.superseded_by_message_id as "supersededByMessageId",
      r.payload,
      r.created_at as "createdAt",
      r.updated_at as "updatedAt"
  `);
  return rows as unknown as ClaimedReminder[];
}

async function spreadDueReminderCollisionsBeforeClaim(now: Date) {
  const nowIso = now.toISOString();
  const rows = await getDb().execute(sql`
    with ranked as (
      select
        r.id,
        r.user_id,
        r.planner_item_id,
        r.policy_id,
        p.policy_type,
        p.ends_at,
        r.scheduled_at as old_scheduled_at,
        row_number() over (
          partition by r.user_id, date_trunc('minute', r.scheduled_at)
          order by r.scheduled_at asc, r.created_at asc, r.id asc
        ) as rn
      from "assistant"."reminders" r
      left join "assistant"."reminder_policies" p on p.id = r.policy_id
      where r.status = 'pending'
        and r.scheduled_at <= ${nowIso}::timestamptz
    )
    update "assistant"."reminders" as r
    set scheduled_at = ${nowIso}::timestamptz + ((ranked.rn - 1) * interval '5 minutes'),
        updated_at = now()
    from ranked
    where r.id = ranked.id
      and ranked.rn > 1
      and not (
        ranked.policy_type in ('interval_window', 'nag_until_ack')
        and ranked.ends_at is not null
        and ${nowIso}::timestamptz + ((ranked.rn - 1) * interval '5 minutes') > ranked.ends_at
      )
    returning
      r.id,
      r.user_id as "userId",
      r.planner_item_id as "plannerItemId",
      r.policy_id as "policyId",
      ranked.old_scheduled_at as "oldScheduledAt",
      r.scheduled_at as "scheduledAt",
      ranked.rn
  `);
  for (const row of rows as unknown as Array<{
    id: string;
    userId: string;
    plannerItemId: string | null;
    policyId: string | null;
    oldScheduledAt: Date | string;
    scheduledAt: Date | string;
    rn: number;
  }>) {
    const oldScheduledAt = toDate(row.oldScheduledAt);
    const scheduledAt = toDate(row.scheduledAt);
    await writeAudit({
      userId: row.userId,
      action: "assistant.reminder_spacing_applied",
      entityType: "reminder",
      entityId: row.id,
      details: {
        phase: "runner_claim",
        plannerItemId: row.plannerItemId,
        policyId: row.policyId,
        originalDesiredAt: oldScheduledAt.toISOString(),
        scheduledAt: scheduledAt.toISOString(),
        shifted: true,
        shiftMinutes: Math.round((scheduledAt.getTime() - oldScheduledAt.getTime()) / 60_000),
        collisionRank: row.rn,
      },
    }).catch(() => undefined);
  }
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

export async function isReminderStillDeliverable(params: { reminderId: string; now: Date }) {
  const nowIso = params.now.toISOString();
  const rows = await getDb().execute(sql`
    select exists (
      select 1
      from "assistant"."reminders" r
      left join "assistant"."reminder_policies" p on p.id = r.policy_id
      left join "assistant"."planner_items" i on i.id = r.planner_item_id
      where r.id = ${params.reminderId}::uuid
        and r.status = 'claimed'
        and (p.snoozed_until is null or p.snoozed_until <= ${nowIso}::timestamptz)
        and (i.snoozed_until is null or i.snoozed_until <= ${nowIso}::timestamptz)
    ) as eligible
  `);
  return Boolean((rows[0] as { eligible?: boolean } | undefined)?.eligible);
}

export async function markReminderSent(params: {
  reminderId: string;
  telegramMessageId?: number | bigint | null;
}) {
  await getDb()
    .update(reminders)
    .set({
      status: "sent",
      sentAt: new Date(),
      telegramMessageId: params.telegramMessageId ? BigInt(params.telegramMessageId) : null,
      updatedAt: new Date(),
    })
    .where(eq(reminders.id, params.reminderId));
}

export async function recordReminderDelivery(params: {
  reminder: ClaimedReminder;
  status: "sent" | "failed";
  telegramMessageId?: number | bigint | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await getDb()
    .insert(reminderDeliveries)
    .values({
      reminderId: params.reminder.id,
      userId: params.reminder.userId,
      status: params.status,
      telegramMessageId: params.telegramMessageId ? BigInt(params.telegramMessageId) : null,
      error: params.error,
      deliveredAt: params.status === "sent" ? new Date() : null,
      metadata: params.metadata ?? {},
    });
}

export async function markReminderFailed(params: {
  reminder: ClaimedReminder;
  error: string;
  retryAt?: Date | null;
}) {
  const retryAt = params.retryAt ?? null;
  const canRetry = params.reminder.attemptCount < 3 && retryAt !== null;
  await getDb()
    .update(reminders)
    .set({
      status: canRetry ? "pending" : "failed",
      scheduledAt: canRetry ? retryAt : params.reminder.scheduledAt,
      lastError: params.error.slice(0, 1000),
      updatedAt: new Date(),
    })
    .where(and(eq(reminders.id, params.reminder.id), eq(reminders.status, "claimed")));
}

export async function restorePolicyReminder(params: { reminderId: string; scheduledAt: Date }) {
  const [row] = await getDb()
    .update(reminders)
    .set({
      status: "pending",
      scheduledAt: params.scheduledAt,
      claimedAt: null,
      sentAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(reminders.id, params.reminderId), inArray(reminders.status, ["failed", "cancelled"])),
    )
    .returning();
  return row ?? null;
}

export async function restoreReminderByIdempotencyKey(params: {
  userId: string;
  idempotencyKey: string;
  scheduledAt: Date;
}) {
  const [row] = await getDb()
    .update(reminders)
    .set({
      status: "pending",
      scheduledAt: params.scheduledAt,
      claimedAt: null,
      sentAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(reminders.userId, params.userId),
        eq(reminders.idempotencyKey, params.idempotencyKey),
        inArray(reminders.status, ["failed", "cancelled"]),
      ),
    )
    .returning();
  return row ?? null;
}

export async function cancelItemReminders(userId: string, plannerItemId: string) {
  await getDb()
    .update(reminders)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(reminders.userId, userId), eq(reminders.plannerItemId, plannerItemId)));
}

export async function listActiveRemindersForItems(userId: string, plannerItemIds: string[]) {
  if (!plannerItemIds.length) return [];
  return getDb()
    .select()
    .from(reminders)
    .where(
      and(
        eq(reminders.userId, userId),
        inArray(reminders.plannerItemId, plannerItemIds),
        inArray(reminders.status, ["pending", "claimed"]),
      ),
    );
}

export async function cancelItemReminderChains(userId: string, plannerItemIds: string[]) {
  if (!plannerItemIds.length) return;
  await getDb()
    .update(reminders)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(reminders.userId, userId),
        inArray(reminders.plannerItemId, plannerItemIds),
        inArray(reminders.status, ["pending", "claimed"]),
      ),
    );
}

export async function cancelPendingRemindersForPolicy(params: {
  userId: string;
  policyId: string;
  from?: Date;
}) {
  const conditions = [
    eq(reminders.userId, params.userId),
    eq(reminders.policyId, params.policyId),
    inArray(reminders.status, ["pending", "claimed"]),
  ];
  if (params.from) conditions.push(gte(reminders.scheduledAt, params.from));
  await getDb()
    .update(reminders)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(...conditions));
}

export async function cancelLegacyRemindersWithoutPolicy(userId: string, plannerItemIds: string[]) {
  if (!plannerItemIds.length) return;
  await getDb()
    .update(reminders)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(reminders.userId, userId),
        inArray(reminders.plannerItemId, plannerItemIds),
        inArray(reminders.status, ["pending", "claimed"]),
        sql`${reminders.policyId} is null`,
      ),
    );
}

export async function archiveDeliveredTestItem(userId: string, plannerItemId: string) {
  await getDb()
    .update(plannerItems)
    .set({
      status: "cancelled",
      metadata: sql`${plannerItems.metadata} || '{"autoArchivedAfterDelivery":true,"isTest":true}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(plannerItems.userId, userId), eq(plannerItems.id, plannerItemId)));
  await cancelItemReminderChains(userId, [plannerItemId]);
}

export async function restoreReminderState(params: {
  userId: string;
  reminderId: string;
  status: string;
  scheduledAt: Date;
}) {
  const [row] = await getDb()
    .update(reminders)
    .set({
      status: params.status,
      scheduledAt: params.scheduledAt,
      updatedAt: new Date(),
    })
    .where(and(eq(reminders.userId, params.userId), eq(reminders.id, params.reminderId)))
    .returning();
  return row ?? null;
}

export async function getLatestReminderForItem(userId: string, plannerItemId: string) {
  const [row] = await getDb()
    .select()
    .from(reminders)
    .where(and(eq(reminders.userId, userId), eq(reminders.plannerItemId, plannerItemId)))
    .orderBy(desc(reminders.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getReminderByIdForUser(params: { userId: string; reminderId: string }) {
  const [row] = await getDb()
    .select()
    .from(reminders)
    .where(and(eq(reminders.userId, params.userId), eq(reminders.id, params.reminderId)))
    .limit(1);
  return row ?? null;
}

export async function getLatestReminderDelivery(reminderId: string) {
  const [row] = await getDb()
    .select()
    .from(reminderDeliveries)
    .where(eq(reminderDeliveries.reminderId, reminderId))
    .orderBy(desc(reminderDeliveries.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getLatestDeliveredReminderContext(params: { userId: string; since: Date }) {
  const [row] = await getDb()
    .select({
      reminderId: reminders.id,
      reminderType: reminders.type,
      plannerItemId: plannerItems.id,
      plannerItemTitle: plannerItems.title,
      plannerItemKind: plannerItems.kind,
      deliveredAt: reminderDeliveries.deliveredAt,
    })
    .from(reminderDeliveries)
    .innerJoin(reminders, eq(reminderDeliveries.reminderId, reminders.id))
    .innerJoin(plannerItems, eq(reminders.plannerItemId, plannerItems.id))
    .where(
      and(
        eq(reminderDeliveries.userId, params.userId),
        eq(reminderDeliveries.status, "sent"),
        inArray(reminders.type, ["followup", "training_followup", "after_event"]),
        gte(reminderDeliveries.deliveredAt, params.since),
      ),
    )
    .orderBy(desc(reminderDeliveries.deliveredAt))
    .limit(1);
  return row ?? null;
}

export async function createReminderIfMissing(params: {
  userId: string;
  plannerItemId?: string | null;
  type: string;
  idempotencyKey: string;
  scheduledAt: Date;
  spacingLatestAt?: Date | null;
  disableSpacing?: boolean;
  repeatUntilAck?: boolean;
  parentReminderId?: string | null;
  recurrenceKey?: string | null;
  policyId?: string | null;
  purpose?: string | null;
  menuType?: string | null;
  autoDeleteAfterResponse?: boolean;
  payload?: Record<string, unknown>;
}) {
  const spacing: {
    scheduledAt: Date;
    shifted: boolean;
    shiftMinutes: number;
    blockedReason?: string;
  } = params.disableSpacing
    ? { scheduledAt: params.scheduledAt, shifted: false, shiftMinutes: 0 as const }
    : await findNextAvailableReminderSlot({
        ownerId: params.userId,
        desiredAt: params.scheduledAt,
        latestAt: params.spacingLatestAt,
      });
  const payload = withSpacingPayload(params.payload ?? {}, params.scheduledAt, spacing);
  const [row] = await getDb()
    .insert(reminders)
    .values({
      userId: params.userId,
      plannerItemId: params.plannerItemId,
      type: params.type,
      idempotencyKey: params.idempotencyKey,
      scheduledAt: spacing.scheduledAt,
      repeatUntilAck: params.repeatUntilAck ?? false,
      parentReminderId: params.parentReminderId,
      recurrenceKey: params.recurrenceKey,
      policyId: params.policyId,
      purpose: params.purpose,
      menuType: params.menuType,
      autoDeleteAfterResponse: params.autoDeleteAfterResponse ?? true,
      payload,
    })
    .onConflictDoNothing({ target: reminders.idempotencyKey })
    .returning();
  if (row && (spacing.shifted || spacing.blockedReason)) {
    await writeAudit({
      userId: params.userId,
      action: "assistant.reminder_spacing_applied",
      entityType: "reminder",
      entityId: row.id,
      details: {
        plannerItemId: params.plannerItemId ?? null,
        policyId: params.policyId ?? null,
        originalDesiredAt: params.scheduledAt.toISOString(),
        scheduledAt: row.scheduledAt.toISOString(),
        shifted: spacing.shifted,
        shiftMinutes: spacing.shiftMinutes,
        blockedReason: spacing.blockedReason ?? null,
      },
    }).catch(() => undefined);
  }
  return row ?? null;
}

function withSpacingPayload(
  payload: Record<string, unknown>,
  desiredAt: Date,
  spacing: { scheduledAt: Date; shifted: boolean; shiftMinutes: number; blockedReason?: string },
) {
  if (!spacing.shifted && !spacing.blockedReason) return payload;
  const metadata =
    payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? (payload.metadata as Record<string, unknown>)
      : {};
  return {
    ...payload,
    metadata: {
      ...metadata,
      originalDesiredAt: desiredAt.toISOString(),
      spacingShiftMinutes: spacing.shiftMinutes,
      spacingReason: spacing.shifted ? "collision_avoidance" : "collision_avoidance_blocked",
      ...(spacing.blockedReason ? { spacingBlockedReason: spacing.blockedReason } : {}),
    },
    originalDesiredAt: desiredAt.toISOString(),
    spacingShiftMinutes: spacing.shiftMinutes,
    spacingReason: spacing.shifted ? "collision_avoidance" : "collision_avoidance_blocked",
  };
}

export async function ackReminderForToday(params: {
  userId: string;
  reminderId: string;
  dayStart: Date;
  dayEnd: Date;
}) {
  const now = new Date();
  const [acked] = await getDb()
    .update(reminders)
    .set({ status: "acked", ackedAt: now, updatedAt: now })
    .where(and(eq(reminders.id, params.reminderId), eq(reminders.userId, params.userId)))
    .returning();

  if (acked?.plannerItemId) {
    await getDb()
      .update(reminders)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(reminders.userId, params.userId),
          eq(reminders.plannerItemId, acked.plannerItemId),
          eq(reminders.status, "pending"),
          gte(reminders.scheduledAt, params.dayStart),
          lt(reminders.scheduledAt, params.dayEnd),
        ),
      );
  }
  return acked ?? null;
}

export async function ackReminderOccurrence(params: { userId: string; reminderId: string }) {
  const now = new Date();
  const [acked] = await getDb()
    .update(reminders)
    .set({ status: "acked", ackedAt: now, updatedAt: now })
    .where(and(eq(reminders.id, params.reminderId), eq(reminders.userId, params.userId)))
    .returning();
  return acked ?? null;
}

export async function snoozeReminder(params: {
  userId: string;
  reminderId: string;
  minutes: number;
}) {
  const [source] = await getDb()
    .select()
    .from(reminders)
    .where(and(eq(reminders.id, params.reminderId), eq(reminders.userId, params.userId)))
    .limit(1);
  if (!source) return null;

  if (source.policyId) {
    const policySnooze = await snoozePolicyReminder({
      source,
      userId: params.userId,
      minutes: params.minutes,
      now: new Date(),
    });
    if (policySnooze) return policySnooze;
    if (source.plannerItemId) return snoozeItemReminder(source, params, true);
    return null;
  }

  return snoozeItemReminder(source, params, false);
}

export async function snoozeReminderUntil(params: {
  userId: string;
  reminderId: string;
  snoozedUntil: Date;
  now?: Date;
  reason?: string;
}) {
  const now = params.now ?? new Date();
  const [source] = await getDb()
    .select()
    .from(reminders)
    .where(and(eq(reminders.id, params.reminderId), eq(reminders.userId, params.userId)))
    .limit(1);
  if (!source) return null;

  if (source.policyId) {
    return getDb().transaction(async (tx) => {
      const [policy] = await tx
        .select()
        .from(reminderPolicies)
        .where(
          and(
            eq(reminderPolicies.id, source.policyId!),
            eq(reminderPolicies.userId, params.userId),
            eq(reminderPolicies.status, "active"),
          ),
        )
        .limit(1);
      if (!policy) return null;

      await tx
        .update(reminders)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(eq(reminders.policyId, policy.id), inArray(reminders.status, ["pending", "claimed"])),
        );

      await tx
        .update(reminderPolicies)
        .set({
          nextFireAt: params.snoozedUntil,
          snoozedUntil: params.snoozedUntil,
          snoozeScope: "policy",
          status: "active",
          metadata: sql`${reminderPolicies.metadata} || ${JSON.stringify({
            lastSnoozedAt: now.toISOString(),
            snoozedUntil: params.snoozedUntil.toISOString(),
            todayWindowSuppressed: true,
            endOfDaySnoozeSemantic: "resume_tomorrow_morning",
            snoozeReason: params.reason ?? "button_end_of_day",
          })}::jsonb`,
          updatedAt: now,
        })
        .where(eq(reminderPolicies.id, policy.id));

      const [snoozedReminder] = await tx
        .insert(reminders)
        .values({
          userId: policy.userId,
          plannerItemId: policy.itemId,
          type: source.type,
          idempotencyKey: `${source.id}:snooze_until:${params.snoozedUntil.toISOString()}`,
          scheduledAt: params.snoozedUntil,
          repeatUntilAck: policy.requireAck || source.repeatUntilAck,
          parentReminderId: source.parentReminderId ?? source.id,
          recurrenceKey: source.recurrenceKey ?? policy.recurrenceRule,
          policyId: policy.id,
          purpose: "snooze",
          menuType: source.menuType ?? "reminder",
          autoDeleteAfterResponse: source.autoDeleteAfterResponse,
          payload: {
            ...(source.payload ?? {}),
            title: policy.title,
            policyType: policy.policyType,
            category: policy.category,
            snoozedFrom: source.id,
            snoozedUntil: params.snoozedUntil.toISOString(),
            endOfDaySnoozeSemantic: "resume_tomorrow_morning",
          },
        })
        .onConflictDoNothing({ target: reminders.idempotencyKey })
        .returning();

      const [occurrence] = await tx
        .insert(reminderPolicyOccurrences)
        .values({
          policyId: policy.id,
          reminderId: snoozedReminder?.id,
          scheduledFor: params.snoozedUntil,
          metadata: { resumedAfterEndOfDaySnooze: true },
        })
        .onConflictDoNothing({
          target: [reminderPolicyOccurrences.policyId, reminderPolicyOccurrences.scheduledFor],
        })
        .returning();
      if (snoozedReminder && occurrence && !occurrence.reminderId) {
        await tx
          .update(reminderPolicyOccurrences)
          .set({ reminderId: snoozedReminder.id })
          .where(eq(reminderPolicyOccurrences.id, occurrence.id));
      }

      return Object.assign(snoozedReminder ?? { ...source, scheduledAt: params.snoozedUntil }, {
        snoozeTarget: "policy_until",
      });
    });
  }

  if (source.plannerItemId) {
    await getDb()
      .update(plannerItems)
      .set({ snoozedUntil: params.snoozedUntil, updatedAt: now })
      .where(and(eq(plannerItems.id, source.plannerItemId), eq(plannerItems.userId, params.userId)));
    await getDb()
      .update(reminders)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(reminders.userId, params.userId),
          eq(reminders.plannerItemId, source.plannerItemId),
          inArray(reminders.status, ["pending", "claimed"]),
        ),
      );
  }
  const reminder = await createReminderIfMissing({
    userId: params.userId,
    plannerItemId: source.plannerItemId,
    type: source.type,
    idempotencyKey: `${source.id}:item_snooze_until:${params.snoozedUntil.toISOString()}`,
    scheduledAt: params.snoozedUntil,
    repeatUntilAck: source.repeatUntilAck,
    parentReminderId: source.parentReminderId ?? source.id,
    recurrenceKey: source.recurrenceKey,
    policyId: source.policyId,
    purpose: "snooze",
    menuType: source.menuType,
    autoDeleteAfterResponse: source.autoDeleteAfterResponse,
    payload: { ...source.payload, snoozedFrom: source.id, snoozedUntil: params.snoozedUntil.toISOString() },
  });
  return reminder ? Object.assign(reminder, { snoozeTarget: "item_until" }) : null;
}

async function snoozeItemReminder(
  source: Reminder,
  params: {
    userId: string;
    reminderId: string;
    minutes: number;
  },
  fallbackUsed: boolean,
) {
  const snoozedUntil = new Date(Date.now() + params.minutes * 60 * 1000);
  if (source.plannerItemId) {
    await getDb()
      .update(plannerItems)
      .set({ snoozedUntil, updatedAt: new Date() })
      .where(
        and(eq(plannerItems.id, source.plannerItemId), eq(plannerItems.userId, params.userId)),
      );
    await getDb()
      .update(reminders)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(reminders.userId, params.userId),
          eq(reminders.plannerItemId, source.plannerItemId),
          eq(reminders.status, "pending"),
          sql`${reminders.scheduledAt} <= ${snoozedUntil.toISOString()}::timestamptz`,
        ),
      );
  }
  const reminder = await createReminderIfMissing({
    userId: params.userId,
    plannerItemId: source.plannerItemId,
    type: source.type,
    idempotencyKey: `${source.id}:snooze:${params.minutes}`,
    scheduledAt: snoozedUntil,
    repeatUntilAck: source.repeatUntilAck,
    parentReminderId: source.parentReminderId ?? source.id,
    recurrenceKey: source.recurrenceKey,
    policyId: source.policyId,
    purpose: "snooze",
    menuType: source.menuType,
    autoDeleteAfterResponse: source.autoDeleteAfterResponse,
    payload: { ...source.payload, snoozedFrom: source.id, snoozeFallbackUsed: fallbackUsed },
  });
  return reminder
    ? Object.assign(reminder, { snoozeTarget: "item", snoozeFallbackUsed: fallbackUsed })
    : null;
}

async function snoozePolicyReminder(params: {
  source: Reminder;
  userId: string;
  minutes: number;
  now: Date;
}) {
  return getDb().transaction(async (tx) => {
    const [policy] = await tx
      .select()
      .from(reminderPolicies)
      .where(
        and(
          eq(reminderPolicies.id, params.source.policyId!),
          eq(reminderPolicies.userId, params.userId),
          eq(reminderPolicies.status, "active"),
        ),
      )
      .limit(1);
    if (!policy) return null;

    const snoozeAt = new Date(params.now.getTime() + params.minutes * 60 * 1000);
    if (
      policy.endsAt &&
      (policy.windowEndInclusive ? snoozeAt > policy.endsAt : snoozeAt >= policy.endsAt)
    ) {
      return null;
    }
    const snoozePlan =
      policy.startsAt && policy.intervalMinutes
        ? planPolicySnooze({
            anchor: policy.startsAt,
            intervalMinutes: policy.intervalMinutes,
            now: params.now,
            snoozeMinutes: params.minutes,
            endsAt: policy.endsAt,
            inclusiveEnd: policy.windowEndInclusive,
          })
        : null;
    if (snoozePlan && !snoozePlan.snoozeAt) return null;
    const nextRegular = snoozePlan?.nextRegularAt ?? policy.nextFireAt;

    await tx
      .update(reminders)
      .set({ status: "cancelled", updatedAt: params.now })
      .where(
        and(eq(reminders.policyId, policy.id), inArray(reminders.status, ["pending", "claimed"])),
      );

    await tx
      .update(reminderPolicies)
      .set({
        nextFireAt: nextRegular,
        snoozedUntil: snoozeAt,
        snoozeScope: "policy",
        status: "active",
        metadata: sql`${reminderPolicies.metadata} || ${JSON.stringify({
          lastSnoozedAt: params.now.toISOString(),
          snoozedUntil: snoozeAt.toISOString(),
          nextGridAfterSnooze: nextRegular?.toISOString() ?? null,
        })}::jsonb`,
        updatedAt: params.now,
      })
      .where(eq(reminderPolicies.id, policy.id));

    const [snoozedReminder] = await tx
      .insert(reminders)
      .values({
        userId: policy.userId,
        plannerItemId: policy.itemId,
        type: params.source.type,
        idempotencyKey: `${params.source.id}:policy_snooze:${snoozeAt.toISOString()}`,
        scheduledAt: snoozeAt,
        repeatUntilAck: policy.requireAck || params.source.repeatUntilAck,
        parentReminderId: params.source.parentReminderId ?? params.source.id,
        recurrenceKey: params.source.recurrenceKey ?? policy.recurrenceRule,
        policyId: policy.id,
        purpose: "snooze",
        menuType: params.source.menuType ?? "reminder",
        autoDeleteAfterResponse: params.source.autoDeleteAfterResponse,
        payload: {
          ...(params.source.payload ?? {}),
          title: policy.title,
          policyType: policy.policyType,
          category: policy.category,
          snoozedFrom: params.source.id,
          snoozedUntil: snoozeAt.toISOString(),
        },
      })
      .onConflictDoNothing({ target: reminders.idempotencyKey })
      .returning();

    if (nextRegular) {
      const [insertedOccurrence] = await tx
        .insert(reminderPolicyOccurrences)
        .values({
          policyId: policy.id,
          scheduledFor: nextRegular,
          metadata: { resumedAfterSnooze: true },
        })
        .onConflictDoNothing({
          target: [reminderPolicyOccurrences.policyId, reminderPolicyOccurrences.scheduledFor],
        })
        .returning();
      const occurrence =
        insertedOccurrence ??
        (
          await tx
            .select()
            .from(reminderPolicyOccurrences)
            .where(
              and(
                eq(reminderPolicyOccurrences.policyId, policy.id),
                eq(reminderPolicyOccurrences.scheduledFor, nextRegular),
              ),
            )
            .limit(1)
        )[0];
      if (occurrence && !occurrence.reminderId) {
        const [regularReminder] = await tx
          .insert(reminders)
          .values({
            userId: policy.userId,
            plannerItemId: policy.itemId,
            type: policy.policyType === "nag_until_ack" ? "until_ack" : "custom",
            idempotencyKey: `policy:${policy.id}:${nextRegular.toISOString()}`,
            scheduledAt: nextRegular,
            repeatUntilAck: policy.requireAck,
            recurrenceKey: policy.recurrenceRule,
            policyId: policy.id,
            purpose: policy.policyType === "interval_window" ? "interval_nag" : "reminder",
            menuType: "reminder",
            payload: {
              title: policy.title,
              policyType: policy.policyType,
              category: policy.category,
              requireAck: policy.requireAck,
              scheduledFor: nextRegular.toISOString(),
              resumedAfterSnooze: true,
            },
          })
          .onConflictDoNothing({ target: reminders.idempotencyKey })
          .returning();
        if (regularReminder) {
          await tx
            .update(reminderPolicyOccurrences)
            .set({ reminderId: regularReminder.id })
            .where(eq(reminderPolicyOccurrences.id, occurrence.id));
        }
      }
    }

    return Object.assign(
      snoozedReminder ?? { ...params.source, scheduledAt: snoozeAt },
      { snoozeTarget: "policy" },
    );
  });
}

export async function stopRecurringReminders(userId: string, plannerItemId: string) {
  await getDb()
    .update(reminders)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(reminders.userId, userId), eq(reminders.plannerItemId, plannerItemId)));
}
