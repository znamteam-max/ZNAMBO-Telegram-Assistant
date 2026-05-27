import { DateTime } from "luxon";
import { InputFile, type Bot } from "grammy";

import { deleteMemoryForUser, exportOwnerData, listActiveMemories } from "@/db/queries/memories";
import { listItemsBetween, listOpenTasks } from "@/db/queries/items";
import { markUserOnboarded, updateUserTimezone } from "@/db/queries/users";
import { assertValidZone } from "@/domain/dateTime";
import { getEnv, isGoogleCalendarConfigured } from "@/lib/env";
import { createGoogleCalendarAuthUrl } from "@/integrations/googleCalendar";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { calendarConnectKeyboard, memoryDeleteKeyboard, startKeyboard } from "./keyboards";
import { formatItemList } from "./formatters";

export function registerCommands(bot: Bot<BotContext>) {
  bot.command("start", async (ctx) => {
    const owner = requireOwner(ctx);
    const calendarUrl = buildCalendarStartUrl(ctx.from?.id);
    await markUserOnboarded(owner.id);
    await ctx.reply(
      [
        "Привет. Я твой личный ежедневник в Telegram.",
        "",
        "Можно написать или надиктовать:",
        "• «В четверг в 12 встреча с Winline»",
        "• «Завтра вечером тренировка Z2 на час»",
        "• «Напомни отправить смету к 18:00»",
        "",
        `Часовой пояс сейчас: ${owner.timezone}.`,
        "Подтверди или измени его в /settings.",
      ].join("\n"),
      { reply_markup: startKeyboard(calendarUrl) },
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "Команды:",
        "/today — сегодня",
        "/tomorrow — завтра",
        "/week — ближайшие 7 дней",
        "/tasks — открытые задачи",
        "/calendar — подключить Google Calendar",
        "/settings Europe/Moscow — сменить часовой пояс",
        "/export — выгрузить данные",
        "/forget — показать память для удаления",
      ].join("\n"),
    );
  });

  bot.command("settings", async (ctx) => {
    const owner = requireOwner(ctx);
    const requested = String(ctx.match ?? "").trim();
    if (!requested) {
      await ctx.reply(`Часовой пояс: ${owner.timezone}\nДля смены: /settings Europe/Moscow`);
      return;
    }
    try {
      assertValidZone(requested);
      const updated = await updateUserTimezone(owner.id, requested);
      ctx.owner = updated;
      await ctx.reply(`Готово. Часовой пояс: ${updated.timezone}`);
    } catch {
      await ctx.reply("Не похоже на IANA timezone. Пример: Europe/Moscow");
    }
  });

  bot.command("calendar", async (ctx) => {
    if (!isGoogleCalendarConfigured()) {
      await ctx.reply(
        "Google Calendar пока отключён: не заданы GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI.",
      );
      return;
    }
    const url = createGoogleCalendarAuthUrl(String(ctx.from?.id));
    await ctx.reply("Подключи Google Calendar по защищённой ссылке:", {
      reply_markup: calendarConnectKeyboard(url),
    });
  });

  bot.command("today", async (ctx) => replySchedule(ctx, "Сегодня", 0, 1));
  bot.command("tomorrow", async (ctx) => replySchedule(ctx, "Завтра", 1, 2));
  bot.command("week", async (ctx) => replySchedule(ctx, "Ближайшие 7 дней", 0, 7));

  bot.command("tasks", async (ctx) => {
    const owner = requireOwner(ctx);
    const tasks = await listOpenTasks(owner.id);
    await ctx.reply(formatItemList("Открытые задачи", tasks, owner.timezone));
  });

  bot.command("export", async (ctx) => {
    const owner = requireOwner(ctx);
    const data = await exportOwnerData(owner.id);
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(JSON.stringify(data, null, 2)), "assistant-export.json"),
      { caption: "Экспорт данных владельца." },
    );
  });

  bot.command("forget", async (ctx) => {
    const owner = requireOwner(ctx);
    const requested = String(ctx.match ?? "").trim();
    if (requested) {
      const deleted = await deleteMemoryForUser(owner.id, requested);
      await ctx.reply(deleted ? "Удалил из памяти." : "Не нашёл такую запись памяти.");
      return;
    }

    const memories = await listActiveMemories(owner.id, 10);
    if (!memories.length) {
      await ctx.reply("Активной памяти пока нет.");
      return;
    }
    for (const memory of memories) {
      await ctx.reply(`[${memory.category}] ${memory.content}`, {
        reply_markup: memoryDeleteKeyboard(memory.id),
      });
    }
  });
}

async function replySchedule(ctx: BotContext, title: string, dayFrom: number, dayTo: number) {
  const owner = requireOwner(ctx);
  const nowLocal = DateTime.utc().setZone(owner.timezone);
  const from = nowLocal.startOf("day").plus({ days: dayFrom }).toUTC().toJSDate();
  const to = nowLocal
    .startOf("day")
    .plus({ days: dayTo })
    .minus({ milliseconds: 1 })
    .toUTC()
    .toJSDate();
  const items = await listItemsBetween({ userId: owner.id, from, to });
  await ctx.reply(formatItemList(title, items, owner.timezone));
}

function buildCalendarStartUrl(telegramUserId?: number): string {
  const baseUrl = getEnv().NEXT_PUBLIC_APP_URL;
  if (!telegramUserId) return baseUrl;
  return `${baseUrl}/api/google/oauth/start?telegram_user_id=${telegramUserId}`;
}
