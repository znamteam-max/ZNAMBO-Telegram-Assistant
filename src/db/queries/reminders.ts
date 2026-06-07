import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { getDb } from "../client";
import { plannerItems, reminderDeliveries, reminders, type Reminder } from "../schema";

export type ClaimedReminder = Reminder;

export async function claimDueReminders(params: {
  now: Date;
  limit: number;
}): Promise<ClaimedReminder[]> {
  const nowIso = params.now.toISOString();
  const rows = await getDb().execute(sql`
    with due as (
      select id
      from "assistant"."reminders"
      where status = 'pending'
        and scheduled_at <= ${nowIso}::timestamptz
      order by scheduled_at asc
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
      r.payload,
      r.created_at as "createdAt",
      r.updated_at as "updatedAt"
  `);
  return rows as unknown as ClaimedReminder[];
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
  await getDb().insert(reminderDeliveries).values({
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

export async function getLatestReminderDelivery(reminderId: string) {
  const [row] = await getDb()
    .select()
    .from(reminderDeliveries)
    .where(eq(reminderDeliveries.reminderId, reminderId))
    .orderBy(desc(reminderDeliveries.createdAt))
    .limit(1);
  return row ?? null;
}

export async function createReminderIfMissing(params: {
  userId: string;
  plannerItemId?: string | null;
  type: string;
  idempotencyKey: string;
  scheduledAt: Date;
  repeatUntilAck?: boolean;
  parentReminderId?: string | null;
  recurrenceKey?: string | null;
  payload?: Record<string, unknown>;
}) {
  const [row] = await getDb()
    .insert(reminders)
    .values({
      userId: params.userId,
      plannerItemId: params.plannerItemId,
      type: params.type,
      idempotencyKey: params.idempotencyKey,
      scheduledAt: params.scheduledAt,
      repeatUntilAck: params.repeatUntilAck ?? false,
      parentReminderId: params.parentReminderId,
      recurrenceKey: params.recurrenceKey,
      payload: params.payload ?? {},
    })
    .onConflictDoNothing({ target: reminders.idempotencyKey })
    .returning();
  return row ?? null;
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

  return createReminderIfMissing({
    userId: params.userId,
    plannerItemId: source.plannerItemId,
    type: source.type,
    idempotencyKey: `${source.id}:snooze:${params.minutes}:${Date.now()}`,
    scheduledAt: new Date(Date.now() + params.minutes * 60 * 1000),
    repeatUntilAck: source.repeatUntilAck,
    parentReminderId: source.parentReminderId ?? source.id,
    recurrenceKey: source.recurrenceKey,
    payload: { ...source.payload, snoozedFrom: source.id },
  });
}

export async function stopRecurringReminders(userId: string, plannerItemId: string) {
  await getDb()
    .update(reminders)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(reminders.userId, userId), eq(reminders.plannerItemId, plannerItemId)));
}
