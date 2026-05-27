import type { Bot } from "grammy";

import { confirmPendingActionInDb, cancelPendingAction } from "@/db/queries/pendingActions";
import { getPlannerItemById, markPlannerItemCompleted } from "@/db/queries/items";
import { deleteMemoryForUser } from "@/db/queries/memories";
import { syncPlannerItemToCalendar } from "@/integrations/calendar";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { afterEventKeyboard } from "./keyboards";
import { formatCreatedItem } from "./formatters";

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
          : sync.status === "error"
            ? "\nВ боте сохранил, но календарь не обновился. Можно повторить позже."
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
    await ctx.reply(item ? `Готово: ${item.title}` : "Не нашёл задачу.");
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
