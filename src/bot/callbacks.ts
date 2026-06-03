import type { Bot } from "grammy";

import { confirmPendingActionInDb, cancelPendingAction } from "@/db/queries/pendingActions";
import { cancelPlannerItem, getPlannerItemById, markPlannerItemCompleted } from "@/db/queries/items";
import { deleteMemoryForUser } from "@/db/queries/memories";
import {
  ackReminderForToday,
  cancelItemReminders,
  snoozeReminder,
  stopRecurringReminders,
} from "@/db/queries/reminders";
import { endOfLocalDay, startOfLocalDay } from "@/domain/dateTime";
import { syncPlannerItemToCalendar } from "@/integrations/calendar";
import { cancelStoredActionPlan, commitStoredActionPlan } from "@/services/actionPlanCommit";
import { syncItemsToCalendarBestEffort } from "@/services/calendarBestEffort";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { afterEventKeyboard } from "./keyboards";
import { formatCommittedPlanSummary, formatCreatedItem } from "./formatters";

export function registerCallbacks(bot: Bot<BotContext>) {
  bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("tz:ok", async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Готово");
    await ctx.reply(`Оставил часовой пояс: ${owner.timezone}`);
  });

  bot.callbackQuery("tz:edit", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Напиши команду в формате: /settings Europe/Moscow");
  });

  bot.callbackQuery(/^pa:ok:(.+)$/, async (ctx) => {
    const pendingActionId = ctx.match[1];
    await ctx.answerCallbackQuery("Сохраняю");
    const result = await confirmPendingActionInDb({
      pendingActionId,
      telegramUserId: String(ctx.from.id),
    });

    if (result.status === "created") {
      const sync = await syncPlannerItemToCalendar(result.item);
      const syncLine =
        sync.status === "synced"
          ? "\nКалендарь: синхронизировано."
          : "";

      await ctx.reply(`${formatCreatedItem(result.item, result.reminders.length)}${syncLine}`, {
        reply_markup: result.item.kind === "event" ? afterEventKeyboard(result.item.id) : undefined,
      });
      return;
    }

    if (result.status === "already_confirmed") {
      await ctx.reply("Эта запись уже была подтверждена.");
      return;
    }
    if (result.status === "cancelled") {
      await ctx.reply("Это предложение уже отменено.");
      return;
    }
    await ctx.reply("Предложение истекло или не найдено. Пришли формулировку заново.");
  });

  bot.callbackQuery(/^plan:confirm:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Сохраняю план");
    const result = await commitStoredActionPlan({
      actionPlanId: ctx.match[1],
      userId: owner.id,
      timezone: owner.timezone,
    });
    if (result.status === "committed") {
      await ctx.reply(
        formatCommittedPlanSummary({
          items: result.items,
          reminderCount: result.reminders.length,
          timezone: owner.timezone,
        }),
      );
      await syncItemsToCalendarBestEffort(result.items);
      return;
    }
    if (result.status === "already_committed") {
      await ctx.reply("Этот план уже сохранён.");
      return;
    }
    await ctx.reply("План уже неактуален или отменён. Пришли формулировку заново.");
  });

  bot.callbackQuery(/^plan:cancel:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Отменено");
    await cancelStoredActionPlan({ actionPlanId: ctx.match[1], userId: owner.id });
    await ctx.reply("Ок, этот план не сохраняю.");
  });

  bot.callbackQuery(/^plan:edit:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Пришли исправленную формулировку одним сообщением. Старый план не меняю автоматически.");
  });

  bot.callbackQuery(/^pa:no:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Отменено");
    await cancelPendingAction(owner.id, ctx.match[1]);
    await ctx.reply("Ок, не сохраняю.");
  });

  bot.callbackQuery(/^pa:edit:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Пришли исправленную формулировку одним сообщением. Старое предложение не сохраняю.",
    );
  });

  bot.callbackQuery(/^done:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Отмечаю");
    const item = await markPlannerItemCompleted(owner.id, ctx.match[1]);
    if (item) await cancelItemReminders(owner.id, item.id);
    await ctx.reply(item ? `Готово: ${item.title}` : "Не нашёл задачу.");
  });

  bot.callbackQuery(/^manage:reschedule:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Напиши новое время для этой задачи одним сообщением. Например: перенеси на завтра 11:30.");
  });

  bot.callbackQuery(/^manage:delete:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await cancelPlannerItem(owner.id, ctx.match[1]);
    if (item) await cancelItemReminders(owner.id, item.id);
    await ctx.answerCallbackQuery(item ? "Удалено" : "Не найдено");
    await ctx.reply(item ? `Удалил: ${item.title}` : "Не нашёл эту запись.");
  });

  bot.callbackQuery("manage:bulk_time", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Напиши, каким задачам поставить время. Например: Зумы РГ в 12:00, созвон НХЛ в 16:30.");
  });

  bot.callbackQuery("manage:bulk_reminder", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Напиши, по каким задачам и когда напомнить. Например: напомни про рилзы ЧМ через 2 часа.");
  });

  bot.callbackQuery(/^reminder:ack:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const now = new Date();
    await ackReminderForToday({
      userId: owner.id,
      reminderId: ctx.match[1],
      dayStart: startOfLocalDay(now, owner.timezone),
      dayEnd: endOfLocalDay(now, owner.timezone),
    });
    await ctx.answerCallbackQuery("Готово");
    await ctx.reply("Принял. На сегодня больше не дёргаю по этому напоминанию.");
  });

  bot.callbackQuery(/^reminder:snooze:([^:]+):(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const minutes = Number(ctx.match[2]);
    await snoozeReminder({ userId: owner.id, reminderId: ctx.match[1], minutes });
    await ctx.answerCallbackQuery("Отложил");
    await ctx.reply(`Ок, напомню через ${minutes} минут.`);
  });

  bot.callbackQuery(/^reminder:skip:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const now = new Date();
    await ackReminderForToday({
      userId: owner.id,
      reminderId: ctx.match[1],
      dayStart: startOfLocalDay(now, owner.timezone),
      dayEnd: endOfLocalDay(now, owner.timezone),
    });
    await ctx.answerCallbackQuery("Пропущено");
    await ctx.reply("Ок, сегодня пропускаем.");
  });

  bot.callbackQuery(/^item:stop_recurring:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await stopRecurringReminders(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery("Остановил");
    await ctx.reply("Остановил будущие повторяющиеся напоминания по этой записи.");
  });

  bot.callbackQuery(/^tentative:happened:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await markPlannerItemCompleted(owner.id, ctx.match[1]);
    if (item) await cancelItemReminders(owner.id, item.id);
    await ctx.answerCallbackQuery(item ? "Отметил" : "Не найдено");
    await ctx.reply(
      item
        ? `Понял, событие было: ${item.title}. Можешь надиктовать итоги, я выделю задачи.`
        : "Не нашёл это tentative-событие.",
    );
  });

  bot.callbackQuery(/^tentative:skipped:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await cancelPlannerItem(owner.id, ctx.match[1]);
    if (item) await cancelItemReminders(owner.id, item.id);
    await ctx.answerCallbackQuery(item ? "Отмечено" : "Не найдено");
    await ctx.reply(item ? `Ок, отмечаю как не состоялось: ${item.title}` : "Не нашёл это tentative-событие.");
  });

  bot.callbackQuery(/^tentative:reschedule:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("На когда перенести? Напиши новой фразой, например: перенеси этот созвон на завтра 12:30.");
  });

  bot.callbackQuery(/^tentative:notes:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Надиктуй или напиши итоги созвона, я разложу их на задачи и заметки.");
  });

  bot.callbackQuery(/^prep:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      item
        ? `Что подготовить к «${item.title}»? Напиши или надиктуй, я предложу задачу на подтверждение.`
        : "Не нашёл встречу.",
    );
  });

  bot.callbackQuery(/^checklist:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      item
        ? [
            `Чек-лист к «${item.title}»:`,
            "• цель встречи",
            "• список вопросов",
            "• нужные материалы",
            "• решение, которое нужно получить",
          ].join("\n")
        : "Не нашёл встречу.",
    );
  });

  bot.callbackQuery(/^forget:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Удаляю");
    const deleted = await deleteMemoryForUser(owner.id, ctx.match[1]);
    await ctx.reply(deleted ? "Удалил из памяти." : "Не нашёл такую запись памяти.");
  });
}
