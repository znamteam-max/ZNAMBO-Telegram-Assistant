import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../client";
import { reminders, type Reminder } from "../schema";

export type ClaimedReminder = Reminder;

export async function claimDueReminders(params: {
  now: Date;
  limit: number;
}): Promise<ClaimedReminder[]> {
  const rows = await getDb().execute(sql`
    with due as (
      select id
      from reminders
      where status = 'pending'
        and scheduled_at <= ${params.now}
      order by scheduled_at asc
      limit ${params.limit}
      for update skip locked
    )
    update reminders as r
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

export async function createReminderIfMissing(params: {
  userId: string;
  plannerItemId?: string | null;
  type: string;
  idempotencyKey: string;
  scheduledAt: Date;
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
      payload: params.payload ?? {},
    })
    .onConflictDoNothing({ target: reminders.idempotencyKey })
    .returning();
  return row ?? null;
}
