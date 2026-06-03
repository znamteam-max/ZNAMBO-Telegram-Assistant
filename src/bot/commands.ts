import { InputFile, type Bot } from "grammy";

import {
  cleanupGarbageTool,
  renderScheduleViewTool,
  renderTaskViewTool,
  renderYesterdayReviewTool,
  undoLastActionTool,
} from "@/agent/jarvisTools";
import { getLatestAuditByAction } from "@/db/queries/audit";
import { deleteMemoryForUser, exportOwnerData, listActiveMemories } from "@/db/queries/memories";
import { createManualPlannerItem } from "@/db/queries/items";
import { createReminderIfMissing } from "@/db/queries/reminders";
import { markUserOnboarded, updateUserTimezone } from "@/db/queries/users";
import { assertValidZone } from "@/domain/dateTime";
import { getCalendarProvider, getEnv, isGoogleCalendarConfigured } from "@/lib/env";
import { createGoogleCalendarAuthUrl } from "@/integrations/googleCalendar";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { calendarConnectKeyboard, memoryDeleteKeyboard, startKeyboard } from "./keyboards";
import { replyAndRecord } from "./reply";

export function registerCommands(bot: Bot<BotContext>) {
  bot.command("start", async (ctx) => {
    const owner = requireOwner(ctx);
    const calendarLink = buildStartCalendarLink(ctx.from?.id);
    await markUserOnboarded(owner.id);
    await ctx.reply(
      [
        "Привет. Я твой личный ежедневник в Telegram.",
        "Теперь я работаю как AI-планировщик: раскладываю длинные сообщения на несколько действий.",
        "",
        "Можно написать или надиктовать:",
        "• «Завтра в 12 встреча с Winline»",
        "• «Каждый понедельник утром напоминай про рилзы»",
        "• «Сегодня после эфира Z2 велосипед на час»",
        "• «Что у меня сегодня?»",
        "",
        `Часовой пояс сейчас: ${owner.timezone}.`,
        `Режим сохранения: ${owner.smartCommitMode}.`,
        "Подтверди или измени его в /settings.",
      ].join("\n"),
      { reply_markup: startKeyboard(calendarLink) },
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
        "/review_yesterday — разбор вчера",
        "/cleanup_garbage — убрать тестовый или случайный мусор",
        "/undo — откатить последнее удаление или cleanup",
        "/remindertest 2 — тестовое напоминание через N минут",
        "/calendar — статус календаря",
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
    const requested = String(ctx.match ?? "").trim().toLowerCase();
    if (requested === "status") {
      await ctx.reply(
        getCalendarProvider() === "yandex"
          ? "Календарь: Yandex CalDAV включён. Если CalDAV вернёт ошибку, задачи и Telegram-напоминания всё равно сохраняются."
          : `Календарь: ${getCalendarProvider()}.`,
      );
      return;
    }
    if (requested === "retry") {
      await ctx.reply("Поставил календарь в best-effort режим. Повторная очередь будет обработана отдельно; записи в боте уже являются источником правды.");
      return;
    }

    if (getCalendarProvider() === "yandex") {
      await ctx.reply("Яндекс Календарь подключён через CalDAV. Новые встречи буду синхронизировать туда.");
      return;
    }

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

  bot.command("today", async (ctx) => replyJarvisTool(ctx, await renderCommandSchedule(ctx, "today")));
  bot.command("tomorrow", async (ctx) => replyJarvisTool(ctx, await renderCommandSchedule(ctx, "tomorrow")));
  bot.command("week", async (ctx) => replyJarvisTool(ctx, await renderCommandSchedule(ctx, "week")));
  bot.command("tasks", async (ctx) => replyJarvisTool(ctx, await renderCommandTasks(ctx)));
  bot.command("review_yesterday", async (ctx) => replyJarvisTool(ctx, await renderCommandYesterday(ctx)));
  bot.command("cleanup_garbage", async (ctx) => replyJarvisTool(ctx, await runCommandCleanup(ctx)));
  bot.command("undo", async (ctx) => replyJarvisTool(ctx, await runCommandUndo(ctx)));

  bot.command("remindertest", async (ctx) => {
    const owner = requireOwner(ctx);
    const minutes = Math.max(1, Math.min(60, Number(String(ctx.match ?? "2").trim()) || 2));
    const scheduledAt = new Date(Date.now() + minutes * 60 * 1000);
    const item = await createManualPlannerItem({
      userId: owner.id,
      kind: "task",
      title: `Тестовое напоминание через ${minutes} мин.`,
      timezone: owner.timezone,
      dueAt: scheduledAt,
      metadata: { debug: true, command: "remindertest" },
    });
    await createReminderIfMissing({
      userId: owner.id,
      plannerItemId: item.id,
      type: "custom",
      idempotencyKey: `${item.id}:remindertest:${scheduledAt.toISOString()}`,
      scheduledAt,
      payload: { title: item.title, debug: true },
    });
    await ctx.reply(
      `Готово. Тестовое напоминание должно прийти через ${minutes} мин. Если не придёт, значит cron runner не дергает /api/reminders/run.`,
    );
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

  bot.command("debuglast", async (ctx) => {
    const owner = requireOwner(ctx);
    const row = await getLatestAuditByAction({ userId: owner.id, action: "assistant.decision_trace" });
    if (!row) {
      await ctx.reply("Пока нет decision trace.");
      return;
    }
    const details = row.details as Record<string, unknown>;
    await ctx.reply(
      [
        "Последнее решение:",
        `intent: ${String(details.intent ?? "unknown")}`,
        `confidence: ${String(details.confidence ?? "unknown")}`,
        `items: ${String(details.extractedItemCount ?? 0)}`,
        `final: ${String(details.finalAction ?? "unknown")}`,
        `warnings: ${Array.isArray(details.validatorWarnings) ? details.validatorWarnings.length : 0}`,
      ].join("\n"),
    );
  });
}

async function renderCommandSchedule(
  ctx: BotContext,
  scope: "today" | "tomorrow" | "week",
) {
  const owner = requireOwner(ctx);
  return renderScheduleViewTool({
    userId: owner.id,
    timezone: owner.timezone,
    sourceMessageId: ctx.dbMessageId,
    scope,
  });
}

async function renderCommandTasks(ctx: BotContext) {
  const owner = requireOwner(ctx);
  return renderTaskViewTool({
    userId: owner.id,
    timezone: owner.timezone,
    sourceMessageId: ctx.dbMessageId,
  });
}

async function renderCommandYesterday(ctx: BotContext) {
  const owner = requireOwner(ctx);
  return renderYesterdayReviewTool({
    userId: owner.id,
    timezone: owner.timezone,
    sourceMessageId: ctx.dbMessageId,
  });
}

async function runCommandCleanup(ctx: BotContext) {
  const owner = requireOwner(ctx);
  return cleanupGarbageTool({
    userId: owner.id,
    timezone: owner.timezone,
    sourceMessageId: ctx.dbMessageId,
  });
}

async function runCommandUndo(ctx: BotContext) {
  const owner = requireOwner(ctx);
  return undoLastActionTool({
    userId: owner.id,
    timezone: owner.timezone,
    sourceMessageId: ctx.dbMessageId,
  });
}

async function replyJarvisTool(ctx: BotContext, result: { reply: string }) {
  await replyAndRecord(ctx, result.reply);
}

function buildCalendarStartUrl(telegramUserId?: number): string {
  const baseUrl = getEnv().NEXT_PUBLIC_APP_URL;
  if (!telegramUserId) return baseUrl;
  return `${baseUrl}/api/google/oauth/start?telegram_user_id=${telegramUserId}`;
}

function buildStartCalendarLink(telegramUserId?: number) {
  const env = getEnv();
  const provider = getCalendarProvider();
  if (provider === "google") {
    return {
      label: "Подключить Google Calendar",
      url: buildCalendarStartUrl(telegramUserId),
    };
  }
  if (provider === "yandex" && env.YANDEX_CALENDAR_URL) {
    return {
      label: "Открыть Яндекс Календарь",
      url: env.YANDEX_CALENDAR_URL,
    };
  }
  return undefined;
}
