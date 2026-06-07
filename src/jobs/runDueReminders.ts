import { DateTime } from "luxon";

import {
  getPlannerItemByAnyId,
  listDailyDigestItems,
  listEveningReviewItems,
  listYesterdayCarryCandidates,
} from "@/db/queries/items";
import {
  archiveDeliveredTestItem,
  claimDueReminders,
  createReminderIfMissing,
  markReminderFailed,
  markReminderSent,
  recordReminderDelivery,
  type ClaimedReminder,
} from "@/db/queries/reminders";
import { getUserById } from "@/db/queries/users";
import { formatReminderMessage } from "@/bot/formatters";
import { reminderActionKeyboard, tentativeEventFollowupKeyboard } from "@/bot/keyboards";
import { logger } from "@/lib/logger";
import { renderAndSaveTaskView } from "@/agent/views/renderAndSaveTaskView";
import { sortJarvisItemsForDisplay } from "@/agent/views/renderShared";

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
      await recordReminderDelivery({
        reminder,
        status: "sent",
        telegramMessageId: sentMessage.message_id,
      });
      const autoArchivedTest = await archiveTestReminderIfNeeded(reminder);
      if (!autoArchivedTest) {
        await scheduleRepeatUntilAck(reminder, now);
        await scheduleNextRecurringOccurrence(reminder, now);
      }
      results.sent += 1;
    } catch (error) {
      results.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await markReminderFailed({
        reminder,
        error: message,
        retryAt: nextRetryAt(reminder, now),
      });
      await recordReminderDelivery({ reminder, status: "failed", error: message });
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
    const nowLocal = DateTime.fromJSDate(reminder.scheduledAt, { zone: "utc" }).setZone(user.timezone);
    const from = nowLocal.startOf("day").toUTC().toJSDate();
    const to = nowLocal.endOf("day").toUTC().toJSDate();
    const yesterdayFrom = nowLocal.minus({ days: 1 }).startOf("day").toUTC().toJSDate();
    const yesterdayTo = nowLocal.minus({ days: 1 }).endOf("day").toUTC().toJSDate();
    const [items, carry] = await Promise.all([
      listDailyDigestItems({ userId: user.id, from, to, limit: 80 }),
      listYesterdayCarryCandidates({
        userId: user.id,
        from: yesterdayFrom,
        to: yesterdayTo,
        limit: 10,
      }),
    ]);
    const rendered = await renderAndSaveTaskView({
      userId: user.id,
      timezone: user.timezone,
      viewType: "today",
      title: `Сегодня, ${nowLocal.setLocale("ru").toFormat("d LLLL")}`,
      sections: [
        { title: "На сегодня", items: sortJarvisItemsForDisplay(items) },
        { title: "Со вчера осталось", items: sortJarvisItemsForDisplay(carry) },
      ],
      emptyText: "Сегодня пока пусто. Можешь надиктовать дела, а я соберу план.",
      metadata: { source: "morning_digest" },
    });
    return sender.sendMessage(user.telegramUserId.toString(), rendered.reply);
  }

  if (reminder.type === "evening_checkin") {
    const nowLocal = DateTime.fromJSDate(reminder.scheduledAt, { zone: "utc" }).setZone(user.timezone);
    const from = nowLocal.startOf("day").toUTC().toJSDate();
    const to = nowLocal.endOf("day").toUTC().toJSDate();
    const tasks = await listEveningReviewItems({ userId: user.id, from, to, limit: 80 });
    const rendered = await renderAndSaveTaskView({
      userId: user.id,
      timezone: user.timezone,
      viewType: "evening_review",
      title: "Вечерняя проверка",
      sections: [{ title: "Сегодня", items: sortJarvisItemsForDisplay(tasks) }],
      emptyText: "На сегодня незакрытых задач нет.",
      footer: "Что делаем? Можно написать: 1 выполнено, 2 на завтра, всё закрыть.",
      metadata: { source: "evening_checkin" },
    });
    return sender.sendMessage(user.telegramUserId.toString(), rendered.reply);
  }

  const item = reminder.plannerItemId ? await getPlannerItemByAnyId(reminder.plannerItemId) : null;
  return sender.sendMessage(user.telegramUserId.toString(), formatReminderMessage(reminder, item), {
    reply_markup: buildReminderKeyboard(reminder, item),
  });
}

function buildReminderKeyboard(reminder: ClaimedReminder, item: Awaited<ReturnType<typeof getPlannerItemByAnyId>>) {
  if (reminder.repeatUntilAck || item?.kind === "recurring_task") {
    return reminderActionKeyboard(reminder.id, reminder.plannerItemId);
  }
  if (reminder.type === "followup" && item?.kind === "tentative_event") {
    return tentativeEventFollowupKeyboard(item.id);
  }
  return undefined;
}

async function archiveTestReminderIfNeeded(reminder: ClaimedReminder) {
  if (!reminder.plannerItemId) return false;
  const item = await getPlannerItemByAnyId(reminder.plannerItemId);
  const payload = (reminder.payload ?? {}) as Record<string, unknown>;
  const isTest =
    item?.metadata?.isTest === true ||
    item?.metadata?.debug === true ||
    item?.metadata?.source === "remindertest" ||
    payload.isTest === true ||
    payload.debug === true ||
    payload.source === "remindertest";
  if (!isTest) return false;
  await archiveDeliveredTestItem(reminder.userId, reminder.plannerItemId);
  return true;
}

function nextRetryAt(reminder: ClaimedReminder, now: Date): Date | null {
  if (reminder.attemptCount >= 3) return null;
  const minutes = reminder.attemptCount === 1 ? 5 : reminder.attemptCount === 2 ? 15 : 30;
  return new Date(now.getTime() + minutes * 60 * 1000);
}

async function scheduleRepeatUntilAck(reminder: ClaimedReminder, now: Date) {
  if (!reminder.repeatUntilAck || reminder.ackedAt) return;
  const payload = (reminder.payload ?? {}) as Record<string, unknown>;

  const user = await getUserById(reminder.userId);
  if (!user) return;
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(user.timezone);
  const repeatAtLocal = nowLocal.plus({ minutes: 75 });
  const twoPm = nowLocal.startOf("day").plus({ hours: 14 });
  const repeatAt = (repeatAtLocal < twoPm ? repeatAtLocal : twoPm).toUTC().toJSDate();
  if (repeatAt.getTime() <= now.getTime()) return;

  await createReminderIfMissing({
    userId: reminder.userId,
    plannerItemId: reminder.plannerItemId,
    type: "until_ack",
    idempotencyKey: `${reminder.id}:until_ack:${repeatAt.toISOString()}`,
    scheduledAt: repeatAt,
    repeatUntilAck: true,
    parentReminderId: reminder.parentReminderId ?? reminder.id,
    recurrenceKey: reminder.recurrenceKey,
    payload: { ...payload, untilAckRepeat: true },
  });
}

async function scheduleNextRecurringOccurrence(reminder: ClaimedReminder, now: Date) {
  if (reminder.type !== "recurring") return;
  const payload = (reminder.payload ?? {}) as {
    recurrence?: { daysOfWeek?: string[]; timeLocal?: string; repeatUntilAck?: boolean };
  };
  const recurrence = payload.recurrence;
  if (!recurrence?.daysOfWeek?.length || !recurrence.timeLocal) return;
  const user = await getUserById(reminder.userId);
  if (!user) return;

  const next = findNextRecurringDate({
    now,
    timezone: user.timezone,
    daysOfWeek: recurrence.daysOfWeek,
    timeLocal: recurrence.timeLocal,
  });
  await createReminderIfMissing({
    userId: reminder.userId,
    plannerItemId: reminder.plannerItemId,
    type: "recurring",
    idempotencyKey: `${reminder.plannerItemId}:recurring:${next.toISOString()}`,
    scheduledAt: next,
    repeatUntilAck: recurrence.repeatUntilAck ?? reminder.repeatUntilAck,
    recurrenceKey: reminder.recurrenceKey,
    payload: reminder.payload,
  });
}

function findNextRecurringDate(params: {
  now: Date;
  timezone: string;
  daysOfWeek: string[];
  timeLocal: string;
}): Date {
  const dayCodes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const [hourRaw, minuteRaw] = params.timeLocal.split(":");
  const hour = Number(hourRaw || 9);
  const minute = Number(minuteRaw || 30);
  const targetWeekdays = new Set(
    params.daysOfWeek.map((day) => dayCodes.indexOf(day) + 1).filter((day) => day > 0),
  );
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = nowLocal
      .startOf("day")
      .plus({ days: offset })
      .set({ hour, minute, second: 0, millisecond: 0 });
    if (targetWeekdays.has(candidate.weekday)) return candidate.toUTC().toJSDate();
  }
  return nowLocal.plus({ days: 1 }).toUTC().toJSDate();
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
