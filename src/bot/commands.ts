import { InputFile, type Bot } from "grammy";

import {
  cleanupGarbageTool,
  prepareResetActivePlanTool,
  renderScheduleViewTool,
  renderTaskViewTool,
  renderYesterdayReviewTool,
  undoLastActionTool,
} from "@/agent/jarvisTools";
import type { JarvisToolResult } from "@/agent/types";
import { getLatestAuditByActions, writeAudit } from "@/db/queries/audit";
import { runOpenAiHealthCheck } from "@/ai/aiHealth";
import { deleteMemoryForUser, exportOwnerData, listActiveMemories } from "@/db/queries/memories";
import { createManualPlannerItem } from "@/db/queries/items";
import { createReminderIfMissing } from "@/db/queries/reminders";
import { markUserOnboarded, updateUserTimezone } from "@/db/queries/users";
import { assertValidZone } from "@/domain/dateTime";
import { getCalendarProvider, getEnv, isGoogleCalendarConfigured } from "@/lib/env";
import { createGoogleCalendarAuthUrl } from "@/integrations/googleCalendar";
import {
  refreshDashboardAfterMutation,
  renderReminderPolicyList,
} from "@/telegram/liveDashboard";
import { cleanupTransientMessages } from "@/telegram/messageLifecycle";

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
        "/aihealth — реальная проверка OpenAI Responses API и tool calling",
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
  bot.command("dashboard", async (ctx) => {
    const owner = requireOwner(ctx);
    if (!ctx.chat?.id) return;
    await refreshDashboardAfterMutation({
      userId: owner.id,
      chatId: ctx.chat.id,
      timezone: owner.timezone,
    });
  });
  bot.command("reminders", async (ctx) => {
    const owner = requireOwner(ctx);
    await replyAndRecord(
      ctx,
      await renderReminderPolicyList({ userId: owner.id, timezone: owner.timezone }),
    );
  });
  bot.command("longterm", async (ctx) => {
    const owner = requireOwner(ctx);
    await replyAndRecord(
      ctx,
      await renderReminderPolicyList({
        userId: owner.id,
        timezone: owner.timezone,
        longTermOnly: true,
      }),
    );
  });
  bot.command("cleanup_chat", async (ctx) => {
    const owner = requireOwner(ctx);
    if (!ctx.chat?.id) return;
    await cleanupTransientMessages({ userId: owner.id, chatId: String(ctx.chat.id) });
    await refreshDashboardAfterMutation({
      userId: owner.id,
      chatId: ctx.chat.id,
      timezone: owner.timezone,
    });
  });
  bot.command("review_yesterday", async (ctx) => replyJarvisTool(ctx, await renderCommandYesterday(ctx)));
  bot.command("cleanup_garbage", async (ctx) => replyJarvisTool(ctx, await runCommandCleanup(ctx)));
  bot.command("admin_reset_active_plan", async (ctx) =>
    replyJarvisTool(ctx, await runCommandResetActivePlan(ctx)),
  );
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
      metadata: { isTest: true, source: "remindertest", debug: true, command: "remindertest" },
    });
    await createReminderIfMissing({
      userId: owner.id,
      plannerItemId: item.id,
      type: "custom",
      idempotencyKey: `${item.id}:remindertest:${scheduledAt.toISOString()}`,
      scheduledAt,
      payload: { title: item.title, isTest: true, source: "remindertest", debug: true },
    });
    await ctx.reply(
      `Готово. Тестовое напоминание должно прийти через ${minutes} мин. Если не придёт, значит cron runner не дергает /api/reminders/run.`,
    );
  });

  bot.command("aihealth", async (ctx) => {
    const owner = requireOwner(ctx);
    const telemetry = await runOpenAiHealthCheck();
    await writeAudit({
      userId: owner.id,
      action: "assistant.ai_health",
      entityType: "telegram_message",
      entityId: ctx.dbMessageId,
      details: {
        ...telemetry,
        pipelineUsed: "aihealth",
        toolCallsExecuted: telemetry.aiSucceeded ? ["report_ai_health"] : [],
        fallbackUsed: false,
        fallbackReason: null,
        finalAction: telemetry.aiSucceeded ? "ai_health_succeeded" : "ai_health_failed",
        createdItemIds: [],
        updatedItemIds: [],
        validationWarnings: [],
      },
    });
    await replyAndRecord(
      ctx,
      telemetry.aiSucceeded
        ? [
            "OpenAI: connected",
            `Model: ${telemetry.aiModel ?? "unknown"}`,
            `Response ID: ${telemetry.openaiResponseId ?? "unknown"}`,
            `Latency: ${telemetry.latencyMs ?? "unknown"} ms`,
            "Structured output: valid",
            "Tool calling: available",
            "No tasks were created.",
          ].join("\n")
        : [
            "OpenAI: unavailable",
            `Error type: ${telemetry.errorCode ?? "unknown"}`,
            "No tasks were created.",
          ].join("\n"),
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
    const row = await getLatestAuditByActions({
      userId: owner.id,
      actions: [
        "assistant.agent_decision_trace",
        "assistant.ai_health",
        "assistant.jarvis_trace",
        "assistant.decision_trace",
      ],
    });
    if (!row) {
      await ctx.reply("Пока нет decision trace.");
      return;
    }
    const details = row.details as Record<string, unknown>;
    await ctx.reply(
      [
        "Последнее AI-решение:",
        `Pipeline: ${String(details.pipelineUsed ?? "unknown")}`,
        `Pre-router: ${String(details.preRouterIntent ?? "none")}`,
        `AI required: ${yesNo(details.aiRequired)}`,
        `AI called: ${yesNo(details.aiCalled)}`,
        `AI succeeded: ${yesNo(details.aiSucceeded)}`,
        `Model: ${String(details.aiModel ?? "unknown")}`,
        `Response ID: ${String(details.openaiResponseId ?? "none")}`,
        `Latency: ${String(details.latencyMs ?? "unknown")} ms`,
        `Tokens: ${String(details.inputTokens ?? "?")} in / ${String(details.outputTokens ?? "?")} out / ${String(details.totalTokens ?? "?")} total`,
        `Structured output: ${details.structuredOutputValid === true ? "valid" : "invalid"}`,
        `Tool calls proposed: ${formatList(details.toolCallsProposed)}`,
        `Tool calls executed: ${formatList(details.toolCallsExecuted)}`,
        `Fallback used: ${yesNo(details.fallbackUsed)}`,
        `Fallback reason: ${String(details.fallbackReason ?? "none")}`,
        `Created items: ${formatList(details.createdItemIds)}`,
        `Updated items: ${formatList(details.updatedItemIds)}`,
        `Warnings: ${formatList(details.validationWarnings)}`,
        `Final action: ${String(details.finalAction ?? "unknown")}`,
        `Error: ${String(details.errorCode ?? "none")}`,
      ].join("\n"),
    );
  });
}

function yesNo(value: unknown) {
  return value === true ? "yes" : "no";
}

function formatList(value: unknown) {
  return Array.isArray(value) && value.length ? value.map(String).join(", ") : "none";
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

async function runCommandResetActivePlan(ctx: BotContext) {
  const owner = requireOwner(ctx);
  return prepareResetActivePlanTool({
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

async function replyJarvisTool(ctx: BotContext, result: JarvisToolResult) {
  await replyAndRecord(
    ctx,
    result.reply,
    result.replyMarkup ? { reply_markup: result.replyMarkup } : undefined,
  );
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
