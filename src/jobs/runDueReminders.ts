import { DateTime } from "luxon";

import { getPlannerItemByAnyId, listItemsBetween, listOpenTasks } from "@/db/queries/items";
import {
  claimDueReminders,
  createReminderIfMissing,
  markReminderFailed,
  markReminderSent,
  type ClaimedReminder,
} from "@/db/queries/reminders";
import { getUserById } from "@/db/queries/users";
import { formatItemList, formatReminderMessage } from "@/bot/formatters";
import { logger } from "@/lib/logger";

import { getBot } from "@/bot/createBot";

export type ReminderTelegramSender = {
  sendMessage(
    chatId: string,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<{ message_id?: number }>;
};

export async function runDueReminders(params?: {
  now?: Date;
  limit?: number;
  sender?: ReminderTelegramSender;
}) {
  const now = params?.now ?? new Date();
  const limit = params?.limit ?? 50;
  const sender = params?.sender ?? getBot().api;
  const due = await claimDueReminders({ now, limit });
  const results = { claimed: due.length, sent: 0, failed: 0 };

  for (const reminder of due) {
    try {
      const sentMessage = await sendReminder(reminder, sender);
      await markReminderSent({
        reminderId: reminder.id,
        telegramMessageId: sentMessage.message_id,
      });
      results.sent += 1;
    } catch (error) {
      results.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await markReminderFailed({
        reminder,
        error: message,
        retryAt: nextRetryAt(reminder, now),
      });
      logger.warn("Reminder send failed", { reminderId: reminder.id, error: message });
    }
  }

  await scheduleTomorrowDigests(now);
  return results;
}

async function sendReminder(reminder: ClaimedReminder, sender: ReminderTelegramSender) {
  const user = await getUserById(reminder.userId);
  if (!user) throw new Error("Reminder user not found");

  if (reminder.type === "morning_digest") {
    const nowLocal = DateTime.utc().setZone(user.timezone);
    const from = nowLocal.startOf("day").toUTC().toJSDate();
    const to = nowLocal.endOf("day").toUTC().toJSDate();
    const items = await listItemsBetween({ userId: user.id, from, to });
    return sender.sendMessage(
      user.telegramUserId.toString(),
      formatItemList("Сегодня", items, user.timezone),
    );
  }

  if (reminder.type === "evening_checkin") {
    const tasks = await listOpenTasks(user.id, 20);
    return sender.sendMessage(
      user.telegramUserId.toString(),
      formatItemList("Вечерняя проверка: невыполненное", tasks, user.timezone),
    );
  }

  const item = reminder.plannerItemId ? await getPlannerItemByAnyId(reminder.plannerItemId) : null;
  return sender.sendMessage(user.telegramUserId.toString(), formatReminderMessage(reminder, item));
}

function nextRetryAt(reminder: ClaimedReminder, now: Date): Date | null {
  if (reminder.attemptCount >= 3) return null;
  const minutes = reminder.attemptCount === 1 ? 5 : reminder.attemptCount === 2 ? 15 : 30;
  return new Date(now.getTime() + minutes * 60 * 1000);
}

async function scheduleTomorrowDigests(now: Date) {
  const { listUsers } = await import("@/db/queries/users");
  const users = await listUsers();
  for (const user of users) {
    const localTomorrow = DateTime.fromJSDate(now, { zone: "utc" })
      .setZone(user.timezone)
      .plus({ days: 1 });
    const morning = localTomorrow.startOf("day").plus({ hours: 8 }).toUTC().toJSDate();
    const evening = localTomorrow.startOf("day").plus({ hours: 21 }).toUTC().toJSDate();
    const dateKey = localTomorrow.toISODate();
    await createReminderIfMissing({
      userId: user.id,
      type: "morning_digest",
      idempotencyKey: `${user.id}:morning_digest:${dateKey}`,
      scheduledAt: morning,
      payload: { date: dateKey },
    });
    await createReminderIfMissing({
      userId: user.id,
      type: "evening_checkin",
      idempotencyKey: `${user.id}:evening_checkin:${dateKey}`,
      scheduledAt: evening,
      payload: { date: dateKey },
    });
  }
}
