import { InputFile, type Bot } from "grammy";
import { DateTime } from "luxon";

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
import { getLatestTranscriptForUser } from "@/db/queries/messages";
import { createManualPlannerItem } from "@/db/queries/items";
import { createReminderIfMissing } from "@/db/queries/reminders";
import { markUserOnboarded, updateUserTimezone } from "@/db/queries/users";
import { assertValidZone } from "@/domain/dateTime";
import { hardenAgentTraceDetails } from "@/domain/agentTraceHygiene";
import { getCalendarProvider, getEnv, isGoogleCalendarConfigured } from "@/lib/env";
import { createGoogleCalendarAuthUrl } from "@/integrations/googleCalendar";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";
import { renderReminderControlCenter } from "@/telegram/reminderControlCenter";
import { renderDailyHistoryView } from "@/services/dailyHistory";
import { renderCleanupPreview } from "@/services/cleanupPreview";
import { renderCompletedItemsView } from "@/services/completedItemsView";
import { renderCronHealth, renderPolicyDebug } from "@/services/reminderDiagnostics";
import {
  applyReminderPolicyRepair,
  previewReminderPolicyRepair,
} from "@/services/reminderPolicyRepair";
import {
  APP_VERSION,
  INTERVAL_ALGORITHM_VERSION,
  POLICY_ENGINE_VERSION,
  RECONCILER_ENABLED,
  RUNNER_LOCK_ENABLED,
} from "@/lib/version";
import {
  applyV242ProductionRepair,
  previewV242ProductionRepair,
} from "@/services/v242ProductionRepair";
import {
  applyV251ProductionRepair,
  previewV251ProductionRepair,
} from "@/services/v251ProductionRepair";
import {
  applyV252ProductionRepair,
  previewV252ProductionRepair,
} from "@/services/v252ProductionRepair";
import {
  getCalendarDebug,
  getCalendarStatus,
  renderCalendarStatus,
  runCalendarWriteTest,
} from "@/services/calendarDiagnostics";
import { getProductionStateV252 } from "@/services/productionDiagnostics";
import { retryCalendarSyncsForUser } from "@/services/calendarSyncRetry";
import {
  applyV253CalendarRepair,
  previewV253CalendarRepair,
} from "@/services/v253CalendarRepair";
import {
  applyV254ProductionRepair,
  previewV254ProductionRepair,
} from "@/services/v254ProductionRepair";
import { detectPlanConflicts } from "@/services/planConflicts";
import {
  getSafeCalendarImportStatus,
  importYandexCalendarForUser,
} from "@/services/yandexCalendarImport";
import {
  applyExternalCalendarCleanup,
  getExternalCalendarVisibilityPreferences,
  previewExternalCalendarCleanup,
  setExternalCalendarVisibilityPreferences,
} from "@/services/externalCalendarCleanup";
import {
  applyV270ProductionRepair,
  previewV270ProductionRepair,
} from "@/services/v270ProductionRepair";
import {
  applyV280ProductionRepair,
  previewV280ProductionRepair,
} from "@/services/v280ProductionRepair";
import {
  applyV290ProductionRepair,
  previewV290ProductionRepair,
} from "@/services/v290ProductionRepair";
import {
  applyV2100ProductionRepair,
  previewV2100ProductionRepair,
} from "@/services/v2100ProductionRepair";
import {
  applyV2110ProductionRepair,
  previewV2110ProductionRepair,
} from "@/services/v2110ProductionRepair";
import {
  applyV2120ProductionRepair,
  previewV2120ProductionRepair,
} from "@/services/v2120ProductionRepair";
import {
  applyV2130ProductionRepair,
  previewV2130ProductionRepair,
} from "@/services/v2130ProductionRepair";
import {
  applyV2140ProductionRepair,
  previewV2140ProductionRepair,
} from "@/services/v2140ProductionRepair";
import { buildActionLog, parseActionLogArgs } from "@/services/actionLog";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import {
  calendarConnectKeyboard,
  memoryDeleteKeyboard,
  navigationKeyboard,
  reminderPolicyRepairKeyboard,
  startKeyboard,
} from "./keyboards";
import { replyAndRecord } from "./reply";
import { clearActiveInteractionSessions } from "./sessionRouting";

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
    await ctx.reply("Быстрая навигация включена.", { reply_markup: navigationKeyboard() });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "Команды:",
        "/today — сегодня",
        "/tomorrow — завтра",
        "/week — ближайшие 7 дней",
        "/plan, /dashboard — главный план: сегодня, завтра, скоро, конфликты и важное",
        "/tasks — полный список для управления: открыть, удалить, перенести или завершить",
        "/review_yesterday — разбор вчера",
        "/cleanup_garbage — убрать тестовый или случайный мусор",
        "/undo — откатить последнее удаление или cleanup",
        "/cancel — отменить текущую настройку или редактирование",
        "/remindertest 2 — тестовое напоминание через N минут",
        "/aihealth — реальная проверка OpenAI Responses API и tool calling",
        "/actionlog, /actionlog 24h, /actionlog 50, /actionlog export — безопасный журнал последних действий",
        "/debugrecent — последние AI/debug traces и agent actions",
        "/reminders — только правила напоминаний; обычные встречи находятся в /plan",
        "/longterm — дальние и регулярные policies",
        "/cleanup_chat — убрать старые bot-карточки",
        "/cleanup — preview очистки без удаления данных плана",
        "/completed, /done — последние выполненные с восстановлением",
        "/cronhealth — статус scheduler и policy reconciler",
        "/policydebug — диагностика последней reminder policy",
        "/versiondebug — версии policy engine, interval algorithm и runner lock",
        "/lasttranscript — показать последнюю расшифровку",
        "/history, /yesterday, /weeklog, /review — история и итоги",
        "/calendar — статус календаря",
        "/calendardebug — безопасная диагностика календаря",
        "/calendar_test — реальный create/read/delete тест Яндекс.Календаря",
        "/calendar_retry_failed — повторить неудачные синхронизации календаря",
        "/calendar_sync — импортировать события из Яндекс.Календаря",
        "/calendar_import_status — безопасный статус последнего импорта",
        "/calendar_cleanup preview|apply — скрыть служебные и прошлые события только в JARVIS",
        "/calendar_view — настройки видимости внешнего календаря",
        "/admin_repair_v253_calendar preview|apply — repair timeout-синхронизаций",
        "/admin_repair_v254 preview|apply — безопасный repair списка после ошибочного удаления",
        "/admin_repair_v270 preview|apply — гигиена календаря, reconciler и stale edit sessions",
        "/admin_repair_v280 preview|apply — cadence-only garbage task и reminder-edit sessions",
        "/admin_repair_v290 preview|apply — исправить ошибочный deadline-блок 14 июня",
        "/admin_repair_v2100 preview|apply — убрать cadence-title garbage task",
        "/admin_repair_v2110 preview|apply — восстановить дедлайн ЧМ и stale sessions",
        "/admin_repair_v2120 preview|apply — recurring UX cleanup и marker repair",
        "/admin_repair_v2130 preview|apply — draft integrity, command targeting и actionlog repair",
        "/admin_repair_v2140 preview|apply — reminder UX/completed/audit hygiene repair",
        "/admin_state_v252 — безопасный production state",
        "/settings Europe/Moscow — сменить часовой пояс",
        "/export — выгрузить данные",
        "/forget — показать память для удаления",
      ].join("\n"),
    );
  });

  bot.command("cancel", async (ctx) => {
    const owner = requireOwner(ctx);
    const cleared = await clearActiveInteractionSessions({
      userId: owner.id,
      reason: "cancel_command",
    });
    await replyAndRecord(
      ctx,
      cleared.length
        ? "Ок, отменил текущую настройку или редактирование. Ничего не изменил."
        : "Активной настройки не было. Ничего не изменил.",
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
    const owner = requireOwner(ctx);
    const requested = String(ctx.match ?? "")
      .trim()
      .toLowerCase();
    if (requested === "status") {
      await ctx.reply(renderCalendarStatus(await getCalendarStatus(owner.id)));
      return;
    }
    if (requested === "retry") {
      await ctx.reply(
        "Поставил календарь в best-effort режим. Повторная очередь будет обработана отдельно; записи в боте уже являются источником правды.",
      );
      return;
    }

    if (getCalendarProvider() === "yandex") {
      await ctx.reply(renderCalendarStatus(await getCalendarStatus(owner.id)));
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

  bot.command("calendardebug", async (ctx) => {
    const owner = requireOwner(ctx);
    const debug = await getCalendarDebug(owner.id);
    await replyAndRecord(
      ctx,
      [
        `calendarProvider: ${debug.provider}`,
        `calendarConfigured: ${debug.configured}`,
        `authorization: ${debug.authorization}`,
        `write: ${debug.write}`,
        `lastWriteStatus: ${debug.lastWriteStatus}`,
        `lastWriteErrorClass: ${debug.lastWriteErrorClass ?? "none"}`,
        `hasUsername: ${debug.hasUsername}`,
        `hasPassword: ${debug.hasPassword}`,
        `hasBaseUrl: ${debug.hasBaseUrl}`,
        `hasCalendarUrl: ${debug.hasCalendarUrl}`,
        `calendarUrlSource: ${debug.calendarUrlSource}`,
        `collectionUrlNormalized: ${debug.collectionUrlNormalized}`,
        `createdObjectUrlPresent: ${debug.createdObjectUrlPresent}`,
        `lastNormalSyncStatus: ${debug.lastNormalSyncStatus ?? "none"}`,
        `lastNormalSyncErrorClass: ${debug.lastNormalSyncErrorClass ?? "none"}`,
        `lastNormalSyncDurationMs: ${debug.lastNormalSyncDurationMs ?? "unknown"}`,
        `pendingCalendarRetries: ${debug.pendingCalendarRetries}`,
        `failedCalendarSyncs: ${debug.failedCalendarSyncs}`,
        `lastCalendarTestStatus: ${debug.lastCalendarTestStatus}`,
        `usesAppPassword: ${debug.usesAppPassword}`,
      ].join("\n"),
    );
  });

  bot.command("calendar_test", async (ctx) => {
    const owner = requireOwner(ctx);
    const result = await runCalendarWriteTest(owner.id);
    await writeAudit({
      userId: owner.id,
      action: "assistant.calendar_write_test",
      entityType: "calendar",
      details: result,
    });
    await replyAndRecord(
      ctx,
      [
        "Тест Яндекс.Календаря:",
        `1. Авторизация — ${result.steps.authorization}`,
        `2. Создание события — ${result.steps.create}`,
        `3. Чтение события — ${result.steps.read}`,
        `4. Удаление теста — ${result.steps.delete}`,
        `Object URL создан: ${result.diagnostics?.createdObjectUrlPresent ? "да" : "нет"}`,
        result.errorClass ? `Ошибка: ${result.errorClass}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  });

  bot.command("calendar_retry_failed", async (ctx) => {
    const owner = requireOwner(ctx);
    const result = await retryCalendarSyncsForUser({ userId: owner.id });
    await replyAndRecord(
      ctx,
      [
        "Повторная синхронизация календаря завершена.",
        `Проверено: ${result.checked}`,
        `Синхронизировано: ${result.synced}`,
        `Ожидают повтора: ${result.pendingRetry}`,
        `Не удалось: ${result.failed}`,
      ].join("\n"),
    );
    if (ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  });

  bot.command("calendar_sync", async (ctx) => {
    const owner = requireOwner(ctx);
    const result = await importYandexCalendarForUser({
      userId: owner.id,
      timezone: owner.timezone,
    });
    await replyAndRecord(
      ctx,
      result.ok
        ? [
            "Импортировал события из Яндекс.Календаря:",
            `• новых: ${result.created}`,
            `• обновлено: ${result.updated}`,
            `• скрытых/удалённых: ${result.hidden}`,
            `• повторяющихся: ${result.recurring}`,
            `• связанных с JARVIS без дубля: ${result.skippedLinked}`,
            "",
            "План обновлён.",
          ].join("\n")
        : `Импорт не выполнен. Безопасный класс ошибки: ${result.errorClass ?? "unknown"}.`,
    );
    if (ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  });

  bot.command("calendar_import_status", async (ctx) => {
    const owner = requireOwner(ctx);
    const status = await getSafeCalendarImportStatus(owner.id);
    await replyAndRecord(
      ctx,
      [
        `lastImportAt: ${status.lastImportAt ?? "never"}`,
        `importedEventsCount: ${status.importedEventsCount}`,
        `recurringEventsCount: ${status.recurringEventsCount}`,
        `externalEventsVisible: ${status.externalEventsVisible}`,
        `possibleDuplicates: ${status.possibleDuplicates}`,
        `lastImportErrorClass: ${status.lastImportErrorClass ?? "none"}`,
      ].join("\n"),
    );
  });

  bot.command("calendar_cleanup", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    const result =
      mode === "apply"
        ? await applyExternalCalendarCleanup({ userId: owner.id })
        : await previewExternalCalendarCleanup({ userId: owner.id });
    await replyAndRecord(
      ctx,
      [
        mode === "apply" ? "Calendar cleanup применён локально." : "Calendar cleanup preview:",
        `• служебных тестовых событий: ${result.counts.serviceEvents}`,
        `• прошлых внешних событий для скрытия по умолчанию: ${result.counts.pastEvents}`,
        `• возможных дублей: ${result.counts.possibleDuplicates}`,
        "",
        "События в Яндекс.Календаре не удалялись.",
        ...(mode === "apply" ? [] : ["Для применения: /calendar_cleanup apply"]),
      ].join("\n"),
    );
    if (mode === "apply" && ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  });

  bot.command("calendar_view", async (ctx) => {
    const owner = requireOwner(ctx);
    const requested = String(ctx.match ?? "").trim().toLowerCase();
    const changes =
      requested === "jarvis_only"
        ? { mode: "jarvis_only" as const }
        : ["today_future", "future"].includes(requested)
          ? { mode: "today_future" as const }
          : ["future_30_days", "30"].includes(requested)
            ? { mode: "future_30_days" as const }
            : requested === "show_past"
              ? { showPast: true }
              : requested === "hide_past"
                ? { showPast: false }
                : requested === "show_service"
                  ? { showServiceEvents: true }
                  : requested === "hide_service"
                    ? { showServiceEvents: false }
                    : null;
    const preferences = changes
      ? await setExternalCalendarVisibilityPreferences({
          userId: owner.id,
          preferences: changes,
        })
      : await getExternalCalendarVisibilityPreferences(owner.id);
    await replyAndRecord(
      ctx,
      [
        "Видимость внешнего календаря:",
        `• режим: ${preferences.mode}`,
        `• показывать прошлое: ${preferences.showPast ? "да" : "нет"}`,
        `• показывать служебные тесты: ${preferences.showServiceEvents ? "да" : "нет"}`,
        "",
        "Команды: /calendar_view jarvis_only | today_future | future_30_days | show_past | hide_past | show_service | hide_service",
      ].join("\n"),
    );
    if (changes && ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  });

  bot.command("today", async (ctx) =>
    replyJarvisTool(ctx, await renderCommandSchedule(ctx, "today")),
  );
  bot.command("tomorrow", async (ctx) =>
    replyJarvisTool(ctx, await renderCommandSchedule(ctx, "tomorrow")),
  );
  bot.command("week", async (ctx) =>
    replyJarvisTool(ctx, await renderCommandSchedule(ctx, "week")),
  );
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
  bot.command("plan", async (ctx) => {
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
    const scope = String(ctx.match ?? "").trim().toLowerCase() || "active";
    const center = await renderReminderControlCenter({
      userId: owner.id,
      timezone: owner.timezone,
      scope,
    });
    await replyAndRecord(ctx, center.text, { reply_markup: center.keyboard });
  });
  bot.command("longterm", async (ctx) => {
    const owner = requireOwner(ctx);
    const center = await renderReminderControlCenter({
      userId: owner.id,
      timezone: owner.timezone,
      scope: "longterm",
    });
    await replyAndRecord(ctx, center.text, { reply_markup: center.keyboard });
  });
  bot.command("distant", async (ctx) => {
    const owner = requireOwner(ctx);
    const center = await renderReminderControlCenter({
      userId: owner.id,
      timezone: owner.timezone,
      scope: "distant",
    });
    await replyAndRecord(ctx, center.text, { reply_markup: center.keyboard });
  });
  bot.command("priority", async (ctx) => {
    const owner = requireOwner(ctx);
    const center = await renderReminderControlCenter({
      userId: owner.id,
      timezone: owner.timezone,
      scope: "active",
    });
    await replyAndRecord(ctx, center.text, { reply_markup: center.keyboard });
  });
  bot.command("cleanup_chat", async (ctx) => {
    const owner = requireOwner(ctx);
    if (!ctx.chat?.id) return;
    const preview = await renderCleanupPreview({
      userId: owner.id,
      chatId: String(ctx.chat.id),
    });
    await replyAndRecord(ctx, preview.text, { reply_markup: preview.keyboard });
  });
  bot.command("cleanup", async (ctx) => {
    const owner = requireOwner(ctx);
    if (!ctx.chat?.id) return;
    const preview = await renderCleanupPreview({
      userId: owner.id,
      chatId: String(ctx.chat.id),
    });
    await replyAndRecord(ctx, preview.text, { reply_markup: preview.keyboard });
  });
  bot.command("completed", async (ctx) => {
    const owner = requireOwner(ctx);
    const view = await renderCompletedItemsView({ userId: owner.id, timezone: owner.timezone });
    await replyAndRecord(ctx, view.text, { reply_markup: view.keyboard });
  });
  bot.command("done", async (ctx) => {
    const owner = requireOwner(ctx);
    const view = await renderCompletedItemsView({ userId: owner.id, timezone: owner.timezone });
    await replyAndRecord(ctx, view.text, { reply_markup: view.keyboard });
  });
  bot.command("cronhealth", async (ctx) => {
    const owner = requireOwner(ctx);
    await replyAndRecord(ctx, await renderCronHealth(owner.timezone));
  });
  bot.command("policydebug", async (ctx) => {
    const owner = requireOwner(ctx);
    const policyId = String(ctx.match ?? "").trim() || null;
    await replyAndRecord(
      ctx,
      await renderPolicyDebug({
        userId: owner.id,
        timezone: owner.timezone,
        policyId,
      }),
    );
  });
  bot.command("versiondebug", async (ctx) => {
    requireOwner(ctx);
    await replyAndRecord(
      ctx,
      [
        `App version: ${APP_VERSION}`,
        `Deployment commit: ${process.env.VERCEL_GIT_COMMIT_SHA ?? "local"}`,
        `Policy engine: ${POLICY_ENGINE_VERSION}`,
        `Interval algorithm: ${INTERVAL_ALGORITHM_VERSION}`,
        `Reconciler enabled: ${RECONCILER_ENABLED ? "yes" : "no"}`,
        `Runner lock enabled: ${RUNNER_LOCK_ENABLED ? "yes" : "no"}`,
      ].join("\n"),
    );
  });
  bot.command("lasttranscript", async (ctx) => {
    const owner = requireOwner(ctx);
    const latest = await getLatestTranscriptForUser(owner.id);
    await replyAndRecord(
      ctx,
      latest?.transcript
        ? `Последняя расшифровка:\n\n${latest.transcript}`
        : "Сохранённых расшифровок пока нет.",
    );
  });
  bot.command("history", async (ctx) => {
    const owner = requireOwner(ctx);
    const view = await renderDailyHistoryView({ userId: owner.id, timezone: owner.timezone, days: 3 });
    await replyAndRecord(ctx, view.text, { reply_markup: view.keyboard });
  });
  bot.command("yesterday", async (ctx) => {
    const owner = requireOwner(ctx);
    const localDate = DateTime.now().setZone(owner.timezone).minus({ days: 1 }).toISODate()!;
    const view = await renderDailyHistoryView({
        userId: owner.id,
        timezone: owner.timezone,
        days: 1,
        endDate: localDate,
      });
    await replyAndRecord(ctx, view.text, { reply_markup: view.keyboard });
  });
  bot.command("weeklog", async (ctx) => {
    const owner = requireOwner(ctx);
    const view = await renderDailyHistoryView({ userId: owner.id, timezone: owner.timezone, days: 7 });
    await replyAndRecord(ctx, view.text, { reply_markup: view.keyboard });
  });
  bot.command("review", async (ctx) => {
    const owner = requireOwner(ctx);
    const view = await renderDailyHistoryView({ userId: owner.id, timezone: owner.timezone, days: 1 });
    await replyAndRecord(ctx, view.text, { reply_markup: view.keyboard });
  });
  bot.command("admin_repair_reminder_policies", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview")
      .trim()
      .toLowerCase();
    if (mode === "apply") {
      const result = await applyReminderPolicyRepair({
        userId: owner.id,
        timezone: owner.timezone,
      });
      await replyAndRecord(
        ctx,
        [
          "Reminder Policy Repair применён.",
          `Исправлено items: ${result.repairedItems.length}`,
          `Архивировано дублей: ${result.archivedItems.length}`,
          `Policies: ${result.policyIds.length}`,
          `Reconcile: ${result.reconcile.checked} проверено, ${result.reconcile.materialized} материализовано`,
        ].join("\n"),
      );
      if (ctx.chat?.id) {
        await refreshDashboardAfterMutation({
          userId: owner.id,
          chatId: ctx.chat.id,
          timezone: owner.timezone,
        });
      }
      return;
    }
    const preview = await previewReminderPolicyRepair({
      userId: owner.id,
      timezone: owner.timezone,
    });
    await replyAndRecord(
      ctx,
      [
        "Reminder Policy Repair preview:",
        ...(preview.groups.length
          ? preview.groups.flatMap((group) => [
              "",
              `${group.group}: ${group.action}`,
              ...group.titles.map((title) => `• ${title}`),
            ])
          : ["Подходящих legacy-записей не найдено."]),
        "",
        "Для применения: /admin_repair_reminder_policies apply",
      ].join("\n"),
      preview.groups.length ? { reply_markup: reminderPolicyRepairKeyboard() } : undefined,
    );
  });
  bot.command("admin_repair_v242", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview")
      .trim()
      .toLowerCase();
    if (mode === "apply") {
      const result = await applyV242ProductionRepair({
        userId: owner.id,
        sourceMessageId: ctx.dbMessageId,
      });
      await replyAndRecord(
        ctx,
        [
          "V2.4.2 production repair применён.",
          `Архивировано partial/generic items: ${result.archivedItemIds.length}`,
          `Истёкших Drik policies: ${result.expiredPolicyIds.length}`,
          `Отменено будущих reminders: ${result.cancelledReminderIds.length}`,
        ].join("\n"),
      );
      if (ctx.chat?.id) {
        await refreshDashboardAfterMutation({
          userId: owner.id,
          chatId: ctx.chat.id,
          timezone: owner.timezone,
        });
      }
      return;
    }
    const preview = await previewV242ProductionRepair({ userId: owner.id });
    await replyAndRecord(
      ctx,
      [
        "V2.4.2 production repair preview:",
        `Items: ${preview.items.length}`,
        ...preview.items.map((item) => `• ${item.title}`),
        `Expired Drik policies: ${preview.policies.length}`,
        `Future reminders to cancel: ${preview.futureReminderIds.length}`,
        `Shifted/duplicate reminder records found: ${preview.shiftedReminderIds.length}`,
        "",
        "Для применения: /admin_repair_v242 apply",
      ].join("\n"),
    );
  });
  bot.command("admin_repair_v251", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    if (mode === "apply") {
      const result = await applyV251ProductionRepair(owner.id);
      await replyAndRecord(
        ctx,
        [
          "V2.5.1 production repair применён.",
          `Malformed items: ${result.malformedItems.length}`,
          `Malformed policies: ${result.malformedPolicies.length}`,
          `Central Park policies grouped: ${result.centralPolicies.length}`,
          `Central Park duplicates expired: ${result.duplicateCentralPolicyIds.length}`,
          `Old bot cards marked stale: ${result.staleBotCards.length}`,
        ].join("\n"),
      );
      if (ctx.chat?.id) {
        await refreshDashboardAfterMutation({
          userId: owner.id,
          chatId: ctx.chat.id,
          timezone: owner.timezone,
        });
      }
      return;
    }
    const preview = await previewV251ProductionRepair(owner.id);
    await replyAndRecord(
      ctx,
      [
        "V2.5.1 production repair preview:",
        `Malformed items: ${preview.malformedItems.length}`,
        `Malformed policies: ${preview.malformedPolicies.length}`,
        `Central Park policies: ${preview.centralPolicies.length}`,
        `Central Park duplicates: ${preview.duplicateCentralPolicyIds.length}`,
        `Old bot cards: ${preview.staleBotCards.length}`,
        "",
        "Для применения: /admin_repair_v251 apply",
      ].join("\n"),
    );
  });
  bot.command("admin_repair_v252", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    const params = { userId: owner.id, timezone: owner.timezone };
    if (mode === "apply") {
      const result = await applyV252ProductionRepair(params);
      await replyAndRecord(
        ctx,
        [
          "V2.5.3 production repair применён.",
          `Ортодонт исправлен: ${result.canonicalOrthodontistId ? 1 : 0}`,
          `Дубли/legacy архивированы: ${result.archivedItemIds.length}`,
          `Старые просроченные перенесены в history: ${result.movedToHistoryItemIds.length}`,
          `Старые bot-карточки скрыты: ${result.staleBotCards.length}`,
          "Снимок для отката сохранён в audit.",
        ].join("\n"),
      );
      if (ctx.chat?.id) {
        await refreshDashboardAfterMutation({
          userId: owner.id,
          chatId: ctx.chat.id,
          timezone: owner.timezone,
        });
      }
      return;
    }
    const result = await previewV252ProductionRepair(params);
    await replyAndRecord(
      ctx,
      [
        "V2.5.3 production repair preview:",
        `Ортодонт: ${result.orthodontistItems.length}`,
        `Legacy Drik: ${result.drikOrphans.length}`,
        `Неразобранные старые записи: ${result.oldOverdueItems.length}`,
        `Старые bot-карточки: ${result.staleBotCards.length}`,
        `Central Park items: ${result.v251.centralItems.length}`,
        `Malformed: ${result.v251.malformedItems.length}`,
        "",
        "Для применения: /admin_repair_v252 apply",
      ].join("\n"),
    );
  });
  bot.command("admin_repair_v253_calendar", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    if (mode === "apply") {
      const result = await applyV253CalendarRepair(owner.id);
      await replyAndRecord(
        ctx,
        [
          "V2.5.3.1 calendar repair применён.",
          `Кандидатов: ${result.preview.candidateCount}`,
          `Ортодонт обнаружен: ${result.preview.orthodontistDetected}`,
          `Синхронизировано: ${result.retry.synced}`,
          `Ожидают повтора: ${result.retry.pendingRetry}`,
          `Не удалось: ${result.retry.failed}`,
        ].join("\n"),
      );
      return;
    }
    const preview = await previewV253CalendarRepair(owner.id);
    await replyAndRecord(
      ctx,
      [
        "V2.5.3.1 calendar repair preview:",
        `Timeout-кандидатов: ${preview.candidateCount}`,
        `Ортодонт обнаружен: ${preview.orthodontistDetected}`,
        ...preview.items.map(
          (item) =>
            `• ${item.title}: ${item.status}/${item.errorClass}; externalIdPresent=${item.externalIdPresent}`,
        ),
        "",
        "Для применения: /admin_repair_v253_calendar apply",
      ].join("\n"),
    );
  });

  bot.command("admin_repair_v254", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "").trim().toLowerCase();
    if (mode === "apply") {
      const result = await applyV254ProductionRepair(owner.id);
      const calendarRetry = await retryCalendarSyncsForUser({ userId: owner.id });
      const conflicts = detectPlanConflicts([
        ...result.retained,
        ...result.restored,
      ]);
      await replyAndRecord(
        ctx,
        [
          "V2.5.4 repair применён.",
          `Восстановлено: ${result.restored.length}`,
          `Архивировано точных Drik-записей: ${result.archived.length}`,
          `Calendar retry synced: ${calendarRetry.synced}`,
          `Конфликтов среди целевых записей: ${conflicts.length}`,
          "Неизвестные записи и policies не изменялись.",
        ].join("\n"),
      );
      if (ctx.chat?.id) {
        await refreshDashboardAfterMutation({
          userId: owner.id,
          chatId: ctx.chat.id,
          timezone: owner.timezone,
        });
      }
      return;
    }
    const preview = await previewV254ProductionRepair(owner.id);
    await replyAndRecord(
      ctx,
      [
        "V2.5.4 repair preview:",
        `Оставить активными: ${preview.retained.length}`,
        ...preview.retained.map((item) => `• ${item.title}`),
        `Восстановить из последнего undo: ${preview.restore.length}`,
        ...preview.restore.map((item) => `• ${item.title}`),
        `Архивировать: ${preview.archive.length}`,
        ...preview.archive.map((item) => `• ${item.title}`),
        "",
        ...preview.notes,
        "",
        "Для применения: /admin_repair_v254 apply",
      ].join("\n"),
    );
  });
  bot.command("admin_repair_v270", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    if (mode === "apply") {
      const result = await applyV270ProductionRepair({ userId: owner.id });
      await replyAndRecord(
        ctx,
        [
          "V2.7.0 production repair применён.",
          `Служебных внешних событий скрыто: ${result.calendar.counts.serviceEvents}`,
          `Прошлых внешних событий скрыто по умолчанию: ${result.calendar.counts.pastEvents}`,
          `Policies reconciled: ${result.reconcile.checked}; materialized: ${result.reconcile.materialized}`,
          `Stale edit sessions cleared: ${result.clearedSessionIds.length}`,
          "Реальные события Яндекс.Календаря и planner items не удалялись.",
        ].join("\n"),
      );
      if (ctx.chat?.id) {
        await refreshDashboardAfterMutation({
          userId: owner.id,
          chatId: ctx.chat.id,
          timezone: owner.timezone,
        });
      }
      return;
    }
    const preview = await previewV270ProductionRepair({ userId: owner.id });
    await replyAndRecord(
      ctx,
      [
        "V2.7.0 production repair preview:",
        `Служебных внешних событий: ${preview.calendar.counts.serviceEvents}`,
        `Прошлых внешних событий: ${preview.calendar.counts.pastEvents}`,
        `Reminder policies к reconcile: ${preview.reminderPoliciesToReconcile}`,
        `Stale edit sessions: ${preview.staleEditSessions.length}`,
        "",
        "Для применения: /admin_repair_v270 apply",
      ].join("\n"),
    );
  });
  bot.command("admin_repair_v280", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    const result =
      mode === "apply"
        ? await applyV280ProductionRepair({ userId: owner.id })
        : await previewV280ProductionRepair({ userId: owner.id });
    const preview = "preview" in result ? result.preview : result;
    await replyAndRecord(
      ctx,
      [
        mode === "apply" ? "V2.8.0 repair применён." : "V2.8.0 repair preview:",
        `Cadence-only garbage tasks: ${preview.garbageCadenceTasks.length}`,
        `Cadence-only garbage policies: ${preview.garbageCadencePolicies.length}`,
        `Candidate target items: ${preview.targetItems.length}`,
        `Safe to attach: ${preview.safeToAttach ? "yes" : "no"}`,
        `Stale reminder-edit sessions: ${preview.staleSessions.length}`,
        ...(mode === "apply"
          ? [
              `Archived garbage tasks: ${"archivedIds" in result ? result.archivedIds.length : 0}`,
              `Created policies: ${"policyIds" in result ? result.policyIds.length : 0}`,
              `Stopped garbage policies: ${"stoppedPolicyIds" in result ? result.stoppedPolicyIds.length : 0}`,
            ]
          : ["Для применения: /admin_repair_v280 apply"]),
        "События Яндекс.Календаря не удалялись.",
      ].join("\n"),
    );
  });
  bot.command("admin_repair_v290", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    const result =
      mode === "apply"
        ? await applyV290ProductionRepair({ userId: owner.id })
        : await previewV290ProductionRepair({ userId: owner.id });
    const preview = "preview" in result ? result.preview : result;
    await replyAndRecord(
      ctx,
      [
        mode === "apply" ? "V2.9.0 repair применён." : "V2.9.0 repair preview:",
        `Deadline-misparsed tasks: ${preview.deadlineMisparsedTasks.length}`,
        `Scheduled block -> deadline-only: ${preview.convertScheduledBlockToDeadlineOnly}`,
        `Calendar updates needed: ${preview.calendarUpdatesNeeded.length}`,
        `Safe to apply: ${preview.safeToApply ? "yes" : "no"}`,
        ...(mode === "apply"
          ? [
              `Updated items: ${"updatedItemIds" in result ? result.updatedItemIds.length : 0}`,
              "Объекты Яндекс.Календаря автоматически не удалялись.",
            ]
          : ["Для применения: /admin_repair_v290 apply"]),
      ].join("\n"),
    );
    if (mode === "apply" && ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  });
  bot.command("admin_repair_v2100", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    const result =
      mode === "apply"
        ? await applyV2100ProductionRepair({ userId: owner.id })
        : await previewV2100ProductionRepair({ userId: owner.id });
    const preview = "preview" in result ? result.preview : result;
    await replyAndRecord(
      ctx,
      [
        mode === "apply" ? "V2.10 repair applied:" : "V2.10 repair preview:",
        `• cadence-title garbage tasks: ${preview.garbageTasks.length}`,
        `• generated garbage policies: ${preview.garbagePolicies.length}`,
        "• Yandex objects to delete: 0",
        `• safe: ${preview.safeToApply ? "yes" : "no"}`,
        ...(mode === "apply"
          ? [
              `• archived garbage tasks: ${"archivedItemIds" in result ? result.archivedItemIds.length : 0}`,
              `• archived garbage policies: ${"archivedPolicyIds" in result ? result.archivedPolicyIds.length : 0}`,
              "• Yandex objects changed: 0",
            ]
          : ["Для применения: /admin_repair_v2100 apply"]),
      ].join("\n"),
    );
    if (mode === "apply" && ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  });
  bot.command("admin_repair_v2110", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    const result =
      mode === "apply"
        ? await applyV2110ProductionRepair({ userId: owner.id })
        : await previewV2110ProductionRepair({ userId: owner.id });
    const preview = "preview" in result ? result.preview : result;
    await replyAndRecord(
      ctx,
      [
        mode === "apply" ? "V2.11 repair applied:" : "V2.11 repair preview:",
        `• target tasks: ${preview.targetItems.length}`,
        `• wrong dueAt detected: ${preview.wrongDueAt ? "yes" : "no"}`,
        `• already expected dueAt: ${preview.alreadyExpectedDueAt ? "yes" : "no"}`,
        `• intended 30-min policies: ${preview.intendedPolicyIds.length}`,
        `• unrelated attached policies: ${preview.unrelatedAttachedPolicyIds.length}`,
        `• stale sessions: ${preview.staleSessionIds.length}`,
        "• Yandex objects to delete: 0",
        `• safe: ${preview.safeToApply ? "yes" : "no"}`,
        ...(mode === "apply"
          ? [
              `• updated items: ${"updatedItemIds" in result ? result.updatedItemIds.length : 0}`,
              `• normalized policies: ${"normalizedPolicyIds" in result ? result.normalizedPolicyIds.length : 0}`,
              `• detached policies: ${"detachedPolicyIds" in result ? result.detachedPolicyIds.length : 0}`,
              `• cleared sessions: ${"clearedSessionIds" in result ? result.clearedSessionIds.length : 0}`,
              "• Yandex objects changed: 0",
            ]
          : ["Для применения: /admin_repair_v2110 apply"]),
      ].join("\n"),
    );
    if (mode === "apply" && ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  });
  bot.command("admin_repair_v2120", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    const result =
      mode === "apply"
        ? await applyV2120ProductionRepair({ userId: owner.id })
        : await previewV2120ProductionRepair({ userId: owner.id });
    const preview = "preview" in result ? result.preview : result;
    await replyAndRecord(
      ctx,
      [
        mode === "apply" ? "V2.12 repair applied:" : "V2.12 repair preview:",
        `• mirror filler-title items: ${preview.mirrorItemIds.length}`,
        `• mirror malformed policies: ${preview.mirrorMalformedPolicyIds.length}`,
        `• mirror target policy: ${preview.mirrorTargetPolicy}`,
        `• Fedotov broken policies: ${preview.fedotovBrokenPolicyIds.length}`,
        `• stale sessions: ${preview.staleSessionIds.length}`,
        "• calendar objects to change: 0",
        `• safe: ${preview.safeToApply ? "yes" : "no"}`,
        ...(mode === "apply"
          ? [
              `• renamed mirror items: ${"renamedItemIds" in result ? result.renamedItemIds.length : 0}`,
              `• replaced mirror policies: ${"replacedPolicyIds" in result ? result.replacedPolicyIds.length : 0}`,
              `• target policies: ${"targetPolicyIds" in result ? result.targetPolicyIds.length : 0}`,
              `• Fedotov moved to review: ${"fedotovMovedToReviewIds" in result ? result.fedotovMovedToReviewIds.length : 0}`,
              `• cleared sessions: ${"clearedSessionIds" in result ? result.clearedSessionIds.length : 0}`,
              "• Yandex objects changed: 0",
            ]
          : ["Для применения: /admin_repair_v2120 apply"]),
      ].join("\n"),
    );
    if (mode === "apply" && ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  });
  bot.command("admin_repair_v2130", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    const result =
      mode === "apply"
        ? await applyV2130ProductionRepair({ userId: owner.id })
        : await previewV2130ProductionRepair({ userId: owner.id });
    const preview = "preview" in result ? result.preview : result;
    await replyAndRecord(
      ctx,
      [
        mode === "apply" ? "V2.13 repair applied:" : "V2.13 repair preview:",
        `• incomplete meter items: ${preview.incompleteMeterItemIds.length}`,
        `• incomplete meter policies: ${preview.incompleteMeterPolicyIds.length}`,
        `• duplicate recurring drafts: ${preview.duplicateRecurringDraftIds.length}`,
        `• stale sessions: ${preview.staleSessionIds.length}`,
        `• orthodontist item: ${preview.orthodontistItemId ?? "none"}`,
        `• orthodontist needs event kind: ${preview.orthodontistNeedsEventKind ? "yes" : "no"}`,
        `• orphan orthodontist policies: ${preview.orphanOrthodontistPolicyIds.length}`,
        "• calendar objects to change: 0",
        `• safe: ${preview.safeToApply ? "yes" : "no"}`,
        ...(mode === "apply"
          ? [
              `• archived items: ${"archivedItemIds" in result ? result.archivedItemIds.length : 0}`,
              `• cancelled policies: ${"cancelledPolicyIds" in result ? result.cancelledPolicyIds.length : 0}`,
              `• cleared drafts: ${"clearedDraftIds" in result ? result.clearedDraftIds.length : 0}`,
              `• cleared sessions: ${"clearedSessionIds" in result ? result.clearedSessionIds.length : 0}`,
              `• normalized items: ${"normalizedItemIds" in result ? result.normalizedItemIds.length : 0}`,
              `• retargeted policies: ${"retargetedPolicyIds" in result ? result.retargetedPolicyIds.length : 0}`,
              "• Yandex objects changed: 0",
            ]
          : ["Для применения: /admin_repair_v2130 apply"]),
      ].join("\n"),
    );
    if (mode === "apply" && ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  });
  bot.command("admin_repair_v2140", async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = String(ctx.match ?? "preview").trim().toLowerCase();
    const result =
      mode === "apply"
        ? await applyV2140ProductionRepair({ userId: owner.id })
        : await previewV2140ProductionRepair({ userId: owner.id });
    await replyAndRecord(
      ctx,
      [
        mode === "apply" ? "V2.14 repair applied:" : "V2.14 repair preview:",
        `• overdue-as-unresolved items: ${result.overdueAsUnresolvedItemIds.length}`,
        `• generic before-event reminders: ${result.genericEventReminderPolicyIds.length}`,
        `• stale recurring drafts: ${result.staleRecurringDraftIds.length}`,
        `• duplicate mirror reminders: ${result.duplicateMirrorPolicyIds.length}`,
        `• completed invisible items: ${result.completedInvisibleItemIds.length}`,
        "• calendar objects to change: 0",
        `• safe: ${result.safeToApply ? "yes" : "no"}`,
        ...(mode === "apply"
          ? [
              `• normalized items: ${arrayLength(result, "normalizedItemIds")}`,
              `• normalized policies: ${arrayLength(result, "normalizedPolicyIds")}`,
              `• cancelled duplicate policies: ${arrayLength(result, "cancelledPolicyIds")}`,
              `• cleared drafts: ${arrayLength(result, "clearedDraftIds")}`,
              "• Yandex objects changed: 0",
            ]
          : ["Для применения: /admin_repair_v2140 apply"]),
      ].join("\n"),
    );
    if (mode === "apply" && ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  });
  bot.command("admin_state_v252", async (ctx) => {
    const owner = requireOwner(ctx);
    const state = await getProductionStateV252({
      userId: owner.id,
      timezone: owner.timezone,
    });
    await replyAndRecord(
      ctx,
      [
        `appVersion: ${state.appVersion}`,
        `deploymentCommit: ${state.deploymentCommit}`,
        `plannerItemCountsByStatus: ${JSON.stringify(state.plannerItemCountsByStatus)}`,
        `plannerItemCountsByDateBucket: ${JSON.stringify(state.plannerItemCountsByDateBucket)}`,
        `activeReminderPolicyCount: ${state.activeReminderPolicyCount}`,
        `orphanReminderLikeItemsCount: ${state.orphanReminderLikeItemsCount}`,
        `calendarProvider: ${state.calendarProvider}`,
        `calendarConfigured: ${state.calendarConfigured}`,
        `calendarLastWriteStatus: ${state.calendarLastWriteStatus}`,
        `calendarLastWriteErrorClass: ${state.calendarLastWriteErrorClass ?? "none"}`,
        `dirtyDataCandidates: ${JSON.stringify(state.dirtyDataCandidates)}`,
      ].join("\n"),
    );
  });
  bot.command("review_yesterday", async (ctx) =>
    replyJarvisTool(ctx, await renderCommandYesterday(ctx)),
  );
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

  bot.command("actionlog", async (ctx) => {
    const owner = requireOwner(ctx);
    const options = parseActionLogArgs(String(ctx.match ?? ""));
    const log = await buildActionLog({
      userId: owner.id,
      hours: options.hours,
      limit: options.limit,
      exportMode: options.exportMode,
    });
    if (options.exportMode) {
      await ctx.replyWithDocument(
        new InputFile(Buffer.from(log.text, "utf8"), "znambo_actionlog.txt"),
        { caption: "Action log export без секретов." },
      );
      return;
    }
    await ctx.reply(log.text || "Action log пуст.");
  });

  bot.command("debugrecent", async (ctx) => {
    const owner = requireOwner(ctx);
    const log = await buildActionLog({
      userId: owner.id,
      hours: 24,
      limit: 50,
    });
    await ctx.reply(log.text || "Debug log пуст.");
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
    const details = hardenAgentTraceDetails(row.details as Record<string, unknown>);
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
        `Tool execution failed: ${String(details.toolExecutionFailed ?? "none")}`,
        `Reason: ${String(details.toolFailureReason ?? "none")}`,
        `Field: ${String(details.toolFailureField ?? "none")}`,
        `Suggested next prompt: ${String(details.suggestedNextPrompt ?? "none")}`,
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

function arrayLength(value: unknown, key: string) {
  if (!value || typeof value !== "object") return 0;
  const nested = (value as Record<string, unknown>)[key];
  return Array.isArray(nested) ? nested.length : 0;
}

async function renderCommandSchedule(ctx: BotContext, scope: "today" | "tomorrow" | "week") {
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
