import type { Bot, InlineKeyboard } from "grammy";
import { DateTime } from "luxon";

import {
  cancelNumberedMutationTool,
  confirmNumberedMutationTool,
  renderScheduleViewTool,
  renderTaskViewTool,
  undoLastActionTool,
} from "@/agent/jarvisTools";
import {
  getItemCalendarSyncState,
  markGoogleCalendarSync,
} from "@/db/queries/googleCalendar";
import {
  disableCalendarSyncForItem,
  getCalendarSyncJobForItem,
} from "@/db/queries/calendarSyncJobs";
import { confirmPendingActionInDb, cancelPendingAction } from "@/db/queries/pendingActions";
import {
  cancelPlannerItem,
  getPlannerItemById,
  listManageableItems,
  markPlannerItemCompleted,
  setPlannerItemManualPriority,
  updatePlannerItemDetails,
} from "@/db/queries/items";
import {
  deleteExternalCalendarEventCache,
  getExternalCalendarEventById,
  hideExternalCalendarEvent,
} from "@/db/queries/externalCalendarEvents";
import { deleteMemoryForUser } from "@/db/queries/memories";
import {
  ackReminderForToday,
  cancelItemReminders,
  snoozeReminder,
  stopRecurringReminders,
} from "@/db/queries/reminders";
import { endOfLocalDay, startOfLocalDay } from "@/domain/dateTime";
import { cancelStoredActionPlan, commitStoredActionPlan } from "@/services/actionPlanCommit";
import {
  formatCalendarSyncFeedback,
  syncItemsToCalendarBestEffort,
} from "@/services/calendarBestEffort";
import { cancelActivePlanReset, executeActivePlanReset } from "@/services/activePlanReset";
import { UserFacingError } from "@/lib/errors";
import {
  createReminderPolicyIfMissing,
  getPolicyForReminder,
  stopPoliciesForItem,
  updatePoliciesPriorityForItem,
  updateReminderPolicy,
  listReminderPoliciesForItem,
} from "@/db/queries/reminderPolicies";
import {
  acknowledgePolicyReminder,
  materializeNextPolicyReminder,
} from "@/services/reminderPolicyEngine";
import {
  applyReminderPolicyRepair,
  previewReminderPolicyRepair,
} from "@/services/reminderPolicyRepair";
import { writeAudit } from "@/db/queries/audit";
import {
  cleanupAfterCallback,
  cleanupPolicyEditorMessages,
  cleanupTransientMessages,
  registerBotMessage,
} from "@/telegram/messageLifecycle";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";
import {
  renderReminderControlCenter,
  renderReminderPolicyCard,
} from "@/telegram/reminderControlCenter";
import { editReminderPolicy } from "@/services/reminderPolicyEditor";
import {
  completeCampaignEventAndActivateNext,
  markCampaignPreparationDone,
  requiresCampaignCompletionClarification,
  updateCampaignState,
} from "@/services/campaignLifecycle";
import { renderEntityCard } from "@/telegram/entityCards";
import type { EntityRefType } from "@/domain/entityRefs";
import { retryCalendarItem } from "@/services/calendarSyncRetry";
import { detectPlanConflicts, formatConflictLine } from "@/services/planConflicts";
import { startItemEditSession } from "@/services/itemEditSessions";
import { deleteYandexCalendarObject } from "@/integrations/yandexCalendar";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import {
  beforeEventReminderMenuKeyboard,
  intervalReminderMenuKeyboard,
  campaignCompletionGuardKeyboard,
  entityListKeyboard,
  itemMenuKeyboard,
  itemMoreKeyboard,
  externalCalendarDeleteKeyboard,
  oneTimeReminderMenuKeyboard,
  policyFrequencyKeyboard,
  priorityEditorKeyboard,
  postCreateTriageKeyboard,
  conflictKeyboard,
  reminderPolicyMenuKeyboard,
  repeatPolicyDeleteKeyboard,
  scheduleReminderMenuKeyboard,
  undoActionKeyboard,
} from "./keyboards";
import { formatCommittedPlanSummary, formatCreatedItem } from "./formatters";
import { cancelItemEditPreview, confirmItemEditPreview } from "./itemEditFlow";

export function registerCallbacks(bot: Bot<BotContext>) {
  bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^calendar:retry:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    if (!item) {
      await ctx.answerCallbackQuery("Событие не найдено");
      return;
    }
    await ctx.answerCallbackQuery("Повторяю синхронизацию");
    const result = await retryCalendarItem(item);
    await ctx.reply(
      result.status === "synced"
        ? `Календарь синхронизирован: ${item.title}`
        : `Событие сохранено в JARVIS. Календарь: ${result.errorClass ?? result.status}; повторю автоматически.`,
    );
    await refreshAfterCallback(ctx, item.id);
  });

  bot.callbackQuery(/^calendar:debug:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    if (!item) {
      await ctx.answerCallbackQuery("Событие не найдено");
      return;
    }
    const [sync, job] = await Promise.all([
      getItemCalendarSyncState(item.id, "yandex_calendar"),
      getCalendarSyncJobForItem(item.id, "yandex_calendar"),
    ]);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        `itemId: ${item.id}`,
        `status: ${sync?.status ?? "unknown"}`,
        `errorClass: ${sync?.lastError ?? "none"}`,
        `durationMs: ${sync?.durationMs ?? "unknown"}`,
        `externalIdPresent: ${Boolean(sync?.externalId)}`,
        `retryJobStatus: ${job?.status ?? "none"}`,
        `retryAttemptCount: ${job?.attemptCount ?? 0}`,
      ].join("\n"),
    );
  });

  bot.callbackQuery(/^calendar:disable:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    if (!item) {
      await ctx.answerCallbackQuery("Событие не найдено");
      return;
    }
    await Promise.all([
      markGoogleCalendarSync({
        item,
        status: "disabled",
        lastError: null,
        provider: "yandex_calendar",
      }),
      disableCalendarSyncForItem(item.id, "yandex_calendar"),
    ]);
    await ctx.answerCallbackQuery("Синхронизация отключена");
    await refreshAfterCallback(ctx, item.id);
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
    const owner = requireOwner(ctx);
    const pendingActionId = ctx.match[1];
    await ctx.answerCallbackQuery("Сохраняю");
    let result;
    try {
      result = await confirmPendingActionInDb({
        pendingActionId,
        telegramUserId: String(ctx.from.id),
      });
    } catch (error) {
      if (error instanceof UserFacingError) {
        await ctx.reply(error.message);
        return;
      }
      throw error;
    }

    if (result.status === "created") {
      const calendarResults = await syncItemsToCalendarBestEffort([result.item]);
      const syncLine = formatCalendarSyncFeedback(calendarResults);

      await ctx.reply([formatCreatedItem(result.item, result.reminders.length), syncLine].filter(Boolean).join("\n\n"), {
        reply_markup: postCreateTriageKeyboard([result.item]),
      });
      const allItems = await listManageableItems(owner.id, 300);
      const conflict = detectPlanConflicts(allItems).find(
        (entry) => entry.first.id === result.item.id || entry.second.id === result.item.id,
      );
      if (conflict) {
        await ctx.reply(
          ["⚠️ Накладка", "", formatConflictLine(conflict, owner.timezone), "", "Что делаем?"].join("\n"),
          { reply_markup: conflictKeyboard(conflict.first.id, conflict.second.id) },
        );
      }
      await refreshAfterCallback(ctx);
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
    let result;
    try {
      result = await commitStoredActionPlan({
        actionPlanId: ctx.match[1],
        userId: owner.id,
        timezone: owner.timezone,
      });
    } catch (error) {
      if (error instanceof UserFacingError) {
        await ctx.reply(error.message);
        return;
      }
      throw error;
    }
    if (result.status === "committed") {
      const calendarResults = await syncItemsToCalendarBestEffort(result.items);
      const calendarFeedback = formatCalendarSyncFeedback(calendarResults);
      await ctx.reply(
        [
          formatCommittedPlanSummary({
            items: result.items,
            reminderCount: result.reminders.length,
            timezone: owner.timezone,
          }),
          calendarFeedback,
        ]
          .filter(Boolean)
          .join("\n\n"),
        result.items.length
          ? { reply_markup: postCreateTriageKeyboard(result.items) }
          : undefined,
      );
      const allItems = await listManageableItems(owner.id, 300);
      const createdIds = new Set(result.items.map((item) => item.id));
      const conflict = detectPlanConflicts(allItems).find(
        (entry) => createdIds.has(entry.first.id) || createdIds.has(entry.second.id),
      );
      if (conflict) {
        await ctx.reply(
          ["⚠️ Накладка", "", formatConflictLine(conflict, owner.timezone), "", "Что делаем?"].join("\n"),
          { reply_markup: conflictKeyboard(conflict.first.id, conflict.second.id) },
        );
      }
      await refreshAfterCallback(ctx);
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
    await ctx.reply(
      "Пришли исправленную формулировку одним сообщением. Старый план не меняю автоматически.",
    );
  });

  bot.callbackQuery(/^reset:confirm:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Очищаю активный план");
    const result = await executeActivePlanReset({
      userId: owner.id,
      actionId: ctx.match[1],
      mode: "all",
    });
    await ctx.reply(
      result.status === "completed"
        ? `Готово. Архивировал активных записей: ${result.items.length}. История, память и recurring-настройки сохранены.`
        : "Этот запрос на очистку уже обработан.",
      result.status === "completed" ? { reply_markup: undoActionKeyboard() } : undefined,
    );
    if (result.status === "completed") await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reset:garbage:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Убираю мусор и тесты");
    const result = await executeActivePlanReset({
      userId: owner.id,
      actionId: ctx.match[1],
      mode: "garbage",
    });
    await ctx.reply(
      result.status === "completed"
        ? `Готово. Архивировал тестовых и ошибочных записей: ${result.items.length}.`
        : "Этот запрос на очистку уже обработан.",
      result.status === "completed" ? { reply_markup: undoActionKeyboard() } : undefined,
    );
    if (result.status === "completed") await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reset:cancel:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await cancelActivePlanReset({ userId: owner.id, actionId: ctx.match[1] });
    await ctx.answerCallbackQuery("Отменено");
    await ctx.reply("Очистку отменил. Ничего не изменено.");
  });

  bot.callbackQuery("reset:show", async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery();
    const result = await renderScheduleViewTool({
      userId: owner.id,
      timezone: owner.timezone,
      sourceMessageId: ctx.dbMessageId,
      scope: "full",
    });
    await ctx.reply(result.reply);
    if (result.affectedItemIds.length) await refreshAfterCallback(ctx);
  });

  bot.callbackQuery("agent:undo", async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Откатываю");
    const result = await undoLastActionTool({
      userId: owner.id,
      timezone: owner.timezone,
      sourceMessageId: ctx.dbMessageId,
    });
    await ctx.reply(result.reply);
    if (result.affectedItemIds.length) await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^safe_mutation:(confirm|cancel):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = ctx.match[1];
    const result =
      mode === "confirm"
        ? await confirmNumberedMutationTool({
            userId: owner.id,
            timezone: owner.timezone,
            sourceMessageId: ctx.dbMessageId,
            actionId: ctx.match[2],
          })
        : await cancelNumberedMutationTool({
            userId: owner.id,
            timezone: owner.timezone,
            sourceMessageId: ctx.dbMessageId,
            actionId: ctx.match[2],
          });
    await ctx.answerCallbackQuery(mode === "confirm" ? "Применяю" : "Отменено");
    await ctx.reply(result.reply, result.replyMarkup ? { reply_markup: result.replyMarkup } : undefined);
    if (mode === "confirm") {
      const tasks = await renderTaskViewTool({
        userId: owner.id,
        timezone: owner.timezone,
        sourceMessageId: ctx.dbMessageId,
      });
      await ctx.reply(tasks.reply, { reply_markup: tasks.replyMarkup });
      await refreshAfterCallback(ctx);
    }
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
    const existing = await getPlannerItemById(owner.id, ctx.match[1]);
    if (existing && requiresCampaignCompletionClarification(existing)) {
      await ctx.answerCallbackQuery("Нужно уточнение");
      await ctx.reply(
        `«${existing.title}» ещё в будущем. Что именно произошло?`,
        { reply_markup: campaignCompletionGuardKeyboard(existing.id) },
      );
      return;
    }
    await ctx.answerCallbackQuery("Отмечаю");
    const item = await markPlannerItemCompleted(owner.id, ctx.match[1]);
    if (item) await cancelItemReminders(owner.id, item.id);
    if (item) await stopPoliciesForItem(owner.id, item.id);
    if (item) {
      await writeAudit({
        userId: owner.id,
        action: "assistant.planner_mutation",
        entityType: "planner_item",
        entityId: item.id,
        details: { mutationSource: "policy_completion", operation: "complete" },
      });
    }
    if (!item) await ctx.reply("Не нашёл задачу.");
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery(/^manage:reschedule:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery(item ? "Жду новое время" : "Не найдено");
    if (!item) {
      await ctx.reply("Не нашёл эту запись.");
      return;
    }
    await startItemEditSession({
      userId: owner.id,
      itemId: item.id,
      mode: "time",
      sourceMessageId: ctx.dbMessageId,
      sourceTelegramMessageId: ctx.callbackQuery?.message?.message_id ?? null,
    });
    await ctx.reply(
      `Меняю время у «${item.title}». Напиши новое время одним сообщением: «на понедельник в 8 утра» или «15.06 на 8 утра».`,
    );
  });

  bot.callbackQuery(/^manage:edit:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery(item ? "Жду правку" : "Не найдено");
    if (item) {
      await startItemEditSession({
        userId: owner.id,
        itemId: item.id,
        mode: "general",
        sourceMessageId: ctx.dbMessageId,
        sourceTelegramMessageId: ctx.callbackQuery?.message?.message_id ?? null,
      });
    }
    await ctx.reply(
      item
        ? `Что изменить в «${item.title}»? Напиши одним сообщением, например: «Изменить на "Новый текст", поставь на понедельник в 8 утра, напоминай раз в час, пока не сделаю».`
        : "Не нашёл эту запись.",
    );
  });

  bot.callbackQuery(/^item_edit:confirm:(.+)$/, async (ctx) => {
    await confirmItemEditPreview(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^item_edit:cancel:(.+)$/, async (ctx) => {
    await cancelItemEditPreview(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^manage:delete:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const policies = await listReminderPoliciesForItem(owner.id, ctx.match[1]);
    const repeatPolicy = policies.find(
      (policy) =>
        policy.status === "active" &&
        ["recurring", "long_term", "interval_window", "nag_until_ack"].includes(policy.policyType),
    );
    if (repeatPolicy) {
      await ctx.answerCallbackQuery("Нужно выбрать");
      await ctx.reply(
        "Удалить только правило напоминания или всю задачу вместе с правилом?",
        { reply_markup: repeatPolicyDeleteKeyboard(repeatPolicy.id, ctx.match[1]) },
      );
      return;
    }
    const item = await cancelPlannerItem(owner.id, ctx.match[1]);
    if (item) await cancelItemReminders(owner.id, item.id);
    if (item) await stopPoliciesForItem(owner.id, item.id);
    if (item) {
      await writeAudit({
        userId: owner.id,
        action: "assistant.planner_mutation",
        entityType: "planner_item",
        entityId: item.id,
        details: { mutationSource: "user_delete_callback", operation: "cancel" },
      });
    }
    await ctx.answerCallbackQuery(item ? "Удалено" : "Не найдено");
    if (!item) await ctx.reply("Не нашёл эту запись.");
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery(/^policy:cancel_rule:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const updated = await editReminderPolicy({
      userId: owner.id,
      policyId: ctx.match[1],
      status: "cancelled",
    });
    await ctx.answerCallbackQuery(updated ? "Правило удалено" : "Не найдено");
    await refreshAfterCallback(ctx, updated?.itemId);
  });

  bot.callbackQuery(/^policy:cancel_all:(.+):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const policy = await editReminderPolicy({
      userId: owner.id,
      policyId: ctx.match[1],
      status: "cancelled",
    });
    const item = await cancelPlannerItem(owner.id, ctx.match[2]);
    if (item) await cancelItemReminders(owner.id, item.id);
    if (item) await stopPoliciesForItem(owner.id, item.id);
    await ctx.answerCallbackQuery(policy || item ? "Удалено" : "Не найдено");
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery("tasks:open", async (ctx) => {
    const owner = requireOwner(ctx);
    const result = await renderTaskViewTool({
      userId: owner.id,
      timezone: owner.timezone,
      sourceMessageId: ctx.dbMessageId,
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(result.reply, { reply_markup: result.replyMarkup });
  });

  bot.callbackQuery("tasks:delete_help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Напиши номера из текущего списка, например: «удалить 5, 6, 7». Сначала покажу preview.");
  });

  bot.callbackQuery("tasks:done_help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Напиши номера из текущего списка, например: «готово 2 и 4».");
  });

  bot.callbackQuery("tasks:review_old", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Открываю старое и неразобранное. Используй /review или /history для подробного разбора.");
  });

  bot.callbackQuery("tasks:archive", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Архив и завершённые записи доступны в /history.");
  });

  bot.callbackQuery("reminders:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Напиши правило одним сообщением: что напоминать, когда и нужно ли повторять до подтверждения.");
  });

  bot.callbackQuery("triage:done", async (ctx) => {
    await ctx.answerCallbackQuery("Оставил как есть");
  });

  bot.callbackQuery(/^triage:(priority|reminders):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === "priority") {
      await ctx.reply("Открой нужный пункт по номеру и выбери «Важность».");
      return;
    }
    await ctx.reply("Открой нужный пункт по номеру и выбери «Добавить напоминание».");
  });

  bot.callbackQuery("conflict:keep", async (ctx) => {
    await ctx.answerCallbackQuery("Оставил оба");
  });

  bot.callbackQuery(/^conflict:open:(.+):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const cards = await Promise.all(
      [ctx.match[1], ctx.match[2]].map((id) =>
        renderEntityCard({
          userId: owner.id,
          timezone: owner.timezone,
          ref: { type: "planner_item", id },
        }),
      ),
    );
    await ctx.answerCallbackQuery();
    for (const card of cards) {
      if (card) await ctx.reply(card.text, { reply_markup: card.keyboard });
    }
  });

  bot.callbackQuery("manage:bulk_time", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Напиши, каким задачам поставить время. Например: Зумы РГ в 12:00, созвон НХЛ в 16:30.",
    );
  });

  bot.callbackQuery("manage:bulk_reminder", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Напиши, по каким задачам и когда напомнить. Например: напомни про рилзы ЧМ через 2 часа.",
    );
  });

  bot.callbackQuery(/^reminder:ack:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const now = new Date();
    const policyRow = await getPolicyForReminder(ctx.match[1]);
    await ackReminderForToday({
      userId: owner.id,
      reminderId: ctx.match[1],
      dayStart: startOfLocalDay(now, owner.timezone),
      dayEnd: endOfLocalDay(now, owner.timezone),
    });
    await acknowledgePolicyReminder(ctx.match[1]);
    if (policyRow?.policy.itemId && policyRow.policy.metadata?.stopOnItemComplete === true) {
      const item = await markPlannerItemCompleted(owner.id, policyRow.policy.itemId);
      if (item) {
        await cancelItemReminders(owner.id, item.id);
        await stopPoliciesForItem(owner.id, item.id);
        await writeAudit({
          userId: owner.id,
          action: "assistant.planner_mutation",
          entityType: "planner_item",
          entityId: item.id,
          details: { mutationSource: "policy_completion", operation: "complete" },
        });
      }
    }
    await ctx.answerCallbackQuery("Готово");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reminder:snooze:([^:]+):(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const minutes = Number(ctx.match[2]);
    const snoozed = await snoozeReminder({
      userId: owner.id,
      reminderId: ctx.match[1],
      minutes,
    });
    await ctx.answerCallbackQuery(snoozed ? "Отложил" : "Окно уже закончилось");
    if (!snoozed) await ctx.reply("Не откладываю: это вышло бы за пределы окна напоминаний.");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reminder:snooze_(evening|tomorrow):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const nowLocal = DateTime.now().setZone(owner.timezone);
    const target =
      ctx.match[1] === "evening"
        ? nowLocal.set({ hour: 19, minute: 0, second: 0, millisecond: 0 })
        : nowLocal.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const future = target > nowLocal ? target : target.plus({ days: 1 });
    const minutes = Math.max(1, Math.ceil(future.diff(nowLocal, "minutes").minutes));
    const snoozed = await snoozeReminder({
      userId: owner.id,
      reminderId: ctx.match[2],
      minutes,
    });
    await ctx.answerCallbackQuery(snoozed ? "Отложил" : "Окно уже закончилось");
    if (!snoozed) await ctx.reply("Не откладываю: это вышло бы за пределы окна напоминаний.");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reminder:edit:(.+)$/, async (ctx) => {
    const row = await getPolicyForReminder(ctx.match[1]);
    await ctx.answerCallbackQuery();
    if (!row?.policy.itemId) {
      await ctx.reply("У этой карточки нет связанной задачи для изменения policy.");
      return;
    }
    await ctx.reply("Как изменить напоминание?", {
      reply_markup: reminderPolicyMenuKeyboard(row.policy.itemId),
    });
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
    await acknowledgePolicyReminder(ctx.match[1], true);
    await ctx.answerCallbackQuery("Пропущено");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reminder:(pause|delete):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const action = ctx.match[1];
    const row = await getPolicyForReminder(ctx.match[2]);
    if (row) {
      await updateReminderPolicy({
        policyId: row.policy.id,
        userId: owner.id,
        status: action === "pause" ? "paused" : "cancelled",
        nextFireAt: null,
      });
    }
    await ctx.answerCallbackQuery(action === "pause" ? "Поставил на паузу" : "Удалил");
    await refreshAfterCallback(ctx, row?.policy.itemId);
  });

  bot.callbackQuery(/^item:stop_recurring:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await stopRecurringReminders(owner.id, ctx.match[1]);
    await stopPoliciesForItem(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery("Остановил");
    await refreshAfterCallback(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^tentative:happened:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await markPlannerItemCompleted(owner.id, ctx.match[1]);
    if (item) await cancelItemReminders(owner.id, item.id);
    if (item) await stopPoliciesForItem(owner.id, item.id);
    await ctx.answerCallbackQuery(item ? "Отметил" : "Не найдено");
    await ctx.reply(
      item
        ? `Понял, событие было: ${item.title}. Можешь надиктовать итоги, я выделю задачи.`
        : "Не нашёл это tentative-событие.",
    );
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery(/^tentative:skipped:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await cancelPlannerItem(owner.id, ctx.match[1]);
    if (item) await cancelItemReminders(owner.id, item.id);
    if (item) await stopPoliciesForItem(owner.id, item.id);
    await ctx.answerCallbackQuery(item ? "Отмечено" : "Не найдено");
    await ctx.reply(
      item ? `Ок, отмечаю как не состоялось: ${item.title}` : "Не нашёл это tentative-событие.",
    );
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery(/^tentative:reschedule:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "На когда перенести? Напиши новой фразой, например: перенеси этот созвон на завтра 12:30.",
    );
  });

  bot.callbackQuery(/^tentative:notes:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Надиктуй или напиши итоги созвона, я разложу их на задачи и заметки.");
  });

  bot.callbackQuery(/^dashboard:item:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery();
    if (!item) {
      await ctx.reply("Эта запись уже не активна.");
      await refreshAfterCallback(ctx);
      return;
    }
    const card = await renderEntityCard({
      userId: owner.id,
      timezone: owner.timezone,
      ref: { type: "planner_item", id: item.id },
    });
    const sent = await ctx.reply(card?.text ?? `${item.title}\n\nЧто делаем?`, {
      reply_markup: card?.keyboard ?? itemMenuKeyboard(item.id),
    });
    if (ctx.chat?.id) {
      await registerBotMessage({
        userId: owner.id,
        chatId: String(ctx.chat.id),
        messageId: sent.message_id,
        purpose: "item_menu",
        relatedItemId: item.id,
      });
    }
  });

  bot.callbackQuery("dashboard:refresh", async (ctx) => {
    await ctx.answerCallbackQuery("Обновляю");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery("dashboard:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Что добавить в план? Напиши или надиктуй одним сообщением.");
  });

  bot.callbackQuery("dashboard:reminders", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyCenter(ctx, "active");
  });

  bot.callbackQuery("dashboard:longterm", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyCenter(ctx, "longterm");
  });

  bot.callbackQuery("dashboard:cleanup", async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Очищаю старые карточки");
    if (ctx.chat?.id) {
      await cleanupTransientMessages({ userId: owner.id, chatId: String(ctx.chat.id) });
    }
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^repair_policies:(preview|apply|manual)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = ctx.match[1];
    await ctx.answerCallbackQuery();
    if (mode === "manual") {
      await ctx.reply(
        "Для ручного архивирования используй явную команду удаления задачи. Очистка Telegram-карточек planner items не меняет.",
      );
      return;
    }
    if (mode === "preview") {
      const preview = await previewReminderPolicyRepair({
        userId: owner.id,
        timezone: owner.timezone,
      });
      await ctx.reply(
        preview.groups.length
          ? preview.groups
              .flatMap((group) => [
                `${group.group}: ${group.action}`,
                ...group.titles.map((title) => `• ${title}`),
              ])
              .join("\n")
          : "Legacy reminder groups не найдены.",
      );
      return;
    }
    const result = await applyReminderPolicyRepair({
      userId: owner.id,
      timezone: owner.timezone,
    });
    await ctx.reply(
      `Конвертация завершена: ${result.repairedItems.length} items, ${result.policyIds.length} policies.`,
    );
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^item:results:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Надиктуй или напиши, что было. Я выделю итоги и новые задачи.");
  });

  bot.callbackQuery(/^item:remind:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Как напоминать?", {
      reply_markup: reminderPolicyMenuKeyboard(ctx.match[1]),
    });
  });

  bot.callbackQuery(
    /^policy_menu:(root|once|before|interval|schedule|until|quiet|category|custom):(.+)$/,
    async (ctx) => {
      const section = ctx.match[1];
      const itemId = ctx.match[2];
      await ctx.answerCallbackQuery();
      if (section === "root") {
        await ctx.reply("Как напоминать?", { reply_markup: reminderPolicyMenuKeyboard(itemId) });
        return;
      }
      if (section === "once") {
        await ctx.reply("Когда напомнить один раз?", {
          reply_markup: oneTimeReminderMenuKeyboard(itemId),
        });
        return;
      }
      if (section === "before") {
        await ctx.reply("За сколько до события?", {
          reply_markup: beforeEventReminderMenuKeyboard(itemId),
        });
        return;
      }
      if (section === "interval") {
        await ctx.reply("Какой интервал?", {
          reply_markup: intervalReminderMenuKeyboard(itemId),
        });
        return;
      }
      if (section === "schedule") {
        await ctx.reply("Какое расписание?", {
          reply_markup: scheduleReminderMenuKeyboard(itemId),
        });
        return;
      }
      const prompts = {
        until: "Напиши интервал и границу: например, каждые 30 минут до 18:00, пока не отмечу.",
        quiet:
          "Напиши правило: не пиши ночью / можно ночью / только утром / только в рабочее время.",
        category:
          "Напиши категорию: content, meeting, training, health, car, home, finance, documents, people или project.",
        custom: "Опиши своё правило одним сообщением. OpenAI разберёт его в typed reminder policy.",
      } as const;
      await ctx.reply(prompts[section as keyof typeof prompts]);
    },
  );

  bot.callbackQuery(/^policy_once:(.+):(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const minutes = Number(ctx.match[2]);
    const created = await createQuickPolicy({
      userId: owner.id,
      itemId: ctx.match[1],
      timezone: owner.timezone,
      policyType: "one_time",
      fireAt: new Date(Date.now() + minutes * 60 * 1000),
    });
    await ctx.answerCallbackQuery(created ? "Настроено" : "Не удалось");
    if (!created) await ctx.reply("Не нашёл активную задачу.");
    await refreshAfterCallback(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^policy_once_(evening|tomorrow):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const local = DateTime.now().setZone(owner.timezone);
    let target =
      ctx.match[1] === "evening"
        ? local.set({ hour: 19, minute: 0, second: 0, millisecond: 0 })
        : local.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    if (target <= local) target = target.plus({ days: 1 });
    const created = await createQuickPolicy({
      userId: owner.id,
      itemId: ctx.match[2],
      timezone: owner.timezone,
      policyType: "one_time",
      fireAt: target.toUTC().toJSDate(),
    });
    await ctx.answerCallbackQuery(created ? "Настроено" : "Не удалось");
    if (!created) await ctx.reply("Не нашёл задачу.");
    await refreshAfterCallback(ctx, ctx.match[2]);
  });

  bot.callbackQuery(/^policy_before:(.+):(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    const anchor = item?.startAt ?? item?.dueAt;
    const minutes = Number(ctx.match[2]);
    const fireAt = anchor ? new Date(anchor.getTime() - minutes * 60 * 1000) : null;
    const created =
      item && fireAt && fireAt > new Date()
        ? await createQuickPolicy({
            userId: owner.id,
            itemId: item.id,
            timezone: item.timezone,
            policyType: "before_event",
            fireAt,
          })
        : null;
    await ctx.answerCallbackQuery(created ? "Настроено" : "Время уже прошло");
    if (!created) await ctx.reply("Не могу поставить это напоминание в будущее.");
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery(/^policy_(interval|schedule|before_multi):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      ctx.match[1] === "interval"
        ? "До какого времени повторять и нужно ли остановить после отметки? Напиши одним сообщением."
        : ctx.match[1] === "schedule"
          ? "Во сколько присылать это регулярное напоминание? Напиши одним сообщением."
          : "Настрою пару напоминаний. Напиши: за день и за час до события.",
    );
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

  bot.callbackQuery(/^policy:list:(active|today|soon|distant|longterm|paused)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyCenter(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^policy:open:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyCard(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^policy:priority:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyEditorMessage(ctx, "Выбери приоритет 1-5:", priorityEditorKeyboard("policy", ctx.match[1]));
  });

  bot.callbackQuery(/^policy:frequency:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyEditorMessage(ctx, "Выбери частоту:", policyFrequencyKeyboard(ctx.match[1]));
  });

  bot.callbackQuery(/^policy:set_priority:(.+):([1-5])$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const updated = await editReminderPolicy({
      userId: owner.id,
      policyId: ctx.match[1],
      basePriority: Number(ctx.match[2]),
    });
    await ctx.answerCallbackQuery(updated ? `Приоритет ${ctx.match[2]}` : "Policy не найдена");
    if (updated) await sendPolicyCard(ctx, updated.id);
  });

  bot.callbackQuery(/^policy:set_interval:(.+):(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const updated = await editReminderPolicy({
      userId: owner.id,
      policyId: ctx.match[1],
      intervalMinutes: Number(ctx.match[2]),
    });
    await ctx.answerCallbackQuery(updated ? "Частота обновлена" : "Policy не найдена");
    if (updated) await sendPolicyCard(ctx, updated.id);
  });

  bot.callbackQuery(/^policy:(pause|resume|cancel):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const action = ctx.match[1];
    const updated = await editReminderPolicy({
      userId: owner.id,
      policyId: ctx.match[2],
      status: action === "resume" ? "active" : action === "pause" ? "paused" : "cancelled",
    });
    await ctx.answerCallbackQuery(
      updated
        ? action === "resume"
          ? "Возобновлено"
          : action === "pause"
            ? "На паузе"
            : "Удалено"
        : "Policy не найдена",
    );
    if (updated?.status === "cancelled") await sendPolicyCenter(ctx, "active");
    else if (updated) await sendPolicyCard(ctx, updated.id);
  });

  bot.callbackQuery(/^item:priority:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyEditorMessage(ctx, "Выбери видимую важность:", priorityEditorKeyboard("item", ctx.match[1]));
  });

  bot.callbackQuery(/^item:set_importance:(.+):(none|important|very_important|auto)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = ctx.match[2];
    const priority = mode === "very_important" ? 5 : mode === "important" ? 4 : 3;
    const updated = await updatePlannerItemDetails({
      userId: owner.id,
      itemId: ctx.match[1],
      priority,
      metadata: {
        basePriority: priority,
        importanceMode: mode === "important" || mode === "very_important" ? "manual" : mode,
      },
    });
    await ctx.answerCallbackQuery(updated ? "Важность обновлена" : "Запись не найдена");
    if (updated) await updatePoliciesPriorityForItem({ userId: owner.id, itemId: updated.id, priority });
    await refreshAfterCallback(ctx, updated?.id);
  });

  bot.callbackQuery(/^item:more:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, "Дополнительные действия", itemMoreKeyboard(ctx.match[1]));
  });

  bot.callbackQuery(/^item:set_priority:(.+):([1-5])$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const updated = await setPlannerItemManualPriority({
      userId: owner.id,
      itemId: ctx.match[1],
      priority: Number(ctx.match[2]),
    });
    if (updated) {
      await updatePoliciesPriorityForItem({
        userId: owner.id,
        itemId: updated.id,
        priority: Number(ctx.match[2]),
      });
    }
    await ctx.answerCallbackQuery(updated ? `Приоритет ${ctx.match[2]}` : "Запись не найдена");
    await refreshAfterCallback(ctx, updated?.id);
  });

  bot.callbackQuery(
    /^entity:open:(planner_item|reminder_policy|campaign|campaign_item|external|history_item|legacy_orphan):(.+)$/,
    async (ctx) => {
      const owner = requireOwner(ctx);
      const card = await renderEntityCard({
        userId: owner.id,
        timezone: owner.timezone,
        ref: {
          type: (ctx.match[1] === "external" ? "external_calendar_event" : ctx.match[1]) as EntityRefType,
          id: ctx.match[2],
        },
      });
      await ctx.answerCallbackQuery(card ? "Открываю" : "Запись не найдена");
      if (card) await editOrReply(ctx, card.text, card.keyboard);
    },
  );

  bot.callbackQuery(/^external:delete_prompt:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(
      ctx,
      "Удалить событие из Яндекс.Календаря тоже?",
      externalCalendarDeleteKeyboard(ctx.match[1]),
    );
  });

  bot.callbackQuery(/^external:hide:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const hidden = await hideExternalCalendarEvent(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery(hidden ? "Скрыто в JARVIS" : "Событие не найдено");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^external:delete_everywhere:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const event = await getExternalCalendarEventById(owner.id, ctx.match[1]);
    if (!event) {
      await ctx.answerCallbackQuery("Событие не найдено");
      return;
    }
    await deleteYandexCalendarObject(event.calendarObjectUrl);
    await deleteExternalCalendarEventCache(owner.id, event.id);
    await ctx.answerCallbackQuery("Удалено из Яндекс.Календаря");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^external:(edit|recurring_info):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const event = await getExternalCalendarEventById(owner.id, ctx.match[2]);
    await ctx.answerCallbackQuery();
    if (!event) return;
    await ctx.reply(
      event.isRecurring
        ? "Это повторяющееся событие. Сейчас поддерживается изменение или удаление всей серии; изменение одного повтора будет добавлено отдельно."
        : "Для внешнего события доступны удаление в Яндекс.Календаре и скрытие в JARVIS. Редактирование содержимого безопаснее выполнить в Яндекс.Календаре; после /calendar_sync План обновится.",
    );
  });

  bot.callbackQuery(/^entity:item_policies:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const policies = await listReminderPoliciesForItem(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      policies.length
        ? policies.map((policy, index) => `${index + 1}. ${policy.title} — ${policy.status}`).join("\n")
        : "Связанных напоминаний пока нет.",
      policies.length
        ? {
            reply_markup: entityListKeyboard(
              policies.map((policy) => ({ type: "reminder_policy", id: policy.id })),
            ),
          }
        : undefined,
    );
  });

  bot.callbackQuery(/^campaign:prep_done:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const updated = await markCampaignPreparationDone(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery(updated ? "Подготовку отметил" : "Запись не найдена");
    if (updated) {
      await ctx.reply("Подготовка отмечена. Само будущее событие осталось активным.");
    }
  });

  bot.callbackQuery(/^campaign:event_passed:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    const result = item
      ? await completeCampaignEventAndActivateNext({ userId: owner.id, item })
      : null;
    if (result?.completed) {
      await cancelItemReminders(owner.id, result.completed.id);
      await stopPoliciesForItem(owner.id, result.completed.id);
    }
    await ctx.answerCallbackQuery(result?.completed ? "Событие завершено" : "Запись не найдена");
    await refreshAfterCallback(ctx, result?.activated?.id ?? result?.completed?.id);
  });

  bot.callbackQuery(/^campaign:(activate|pause|resume|cancel|priority):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const action = ctx.match[1];
    if (action === "priority") {
      await ctx.answerCallbackQuery();
      await ctx.reply("Напиши новую важность кампании одним сообщением, например: «Central Park очень важно».");
      return;
    }
    const result = await updateCampaignState({
      userId: owner.id,
      campaignGroup: ctx.match[2],
      action: action as "activate" | "pause" | "resume" | "cancel",
    });
    await ctx.answerCallbackQuery("Готово");
    await ctx.reply(`Кампания обновлена: ${result.itemCount} элементов, ${result.policyCount} политик.`);
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^forget:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Удаляю");
    const deleted = await deleteMemoryForUser(owner.id, ctx.match[1]);
    await ctx.reply(deleted ? "Удалил из памяти." : "Не нашёл такую запись памяти.");
  });
}

async function sendPolicyCenter(ctx: BotContext, scope: string) {
  const owner = requireOwner(ctx);
  const center = await renderReminderControlCenter({
    userId: owner.id,
    timezone: owner.timezone,
    scope,
  });
  await sendPolicyEditorMessage(ctx, center.text, center.keyboard);
}

async function sendPolicyCard(ctx: BotContext, policyId: string) {
  const owner = requireOwner(ctx);
  const card = await renderReminderPolicyCard({
    userId: owner.id,
    policyId,
    timezone: owner.timezone,
  });
  if (!card) {
    await ctx.answerCallbackQuery("Policy не найдена");
    return;
  }
  await sendPolicyEditorMessage(ctx, card.text, card.keyboard);
}

async function sendPolicyEditorMessage(
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard,
) {
  const owner = requireOwner(ctx);
  if (!ctx.chat?.id) return;
  await cleanupPolicyEditorMessages({ userId: owner.id, chatId: String(ctx.chat.id) });
  const sent = await ctx.reply(text, { reply_markup: keyboard });
  await registerBotMessage({
    userId: owner.id,
    chatId: String(ctx.chat.id),
    messageId: sent.message_id,
    purpose: "policy_editor",
  });
}

async function editOrReply(ctx: BotContext, text: string, keyboard: InlineKeyboard) {
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
      return;
    } catch {
      // Telegram rejects edits when the message is no longer editable or unchanged.
    }
  }
  await ctx.reply(text, { reply_markup: keyboard });
}

async function refreshAfterCallback(ctx: BotContext, relatedItemId?: string | null) {
  const owner = requireOwner(ctx);
  if (!ctx.chat?.id) return;
  await cleanupAfterCallback({
    userId: owner.id,
    chatId: String(ctx.chat.id),
    messageId: ctx.callbackQuery?.message?.message_id,
    relatedItemId,
  });
  await refreshDashboardAfterMutation({
    userId: owner.id,
    chatId: ctx.chat.id,
    timezone: owner.timezone,
  });
}

async function createQuickPolicy(params: {
  userId: string;
  itemId: string;
  timezone: string;
  policyType: "one_time" | "before_event";
  fireAt: Date;
}) {
  const item = await getPlannerItemById(params.userId, params.itemId);
  if (!item || item.status !== "active") return null;
  const policy = await createReminderPolicyIfMissing({
    userId: params.userId,
    itemId: item.id,
    title: item.title,
    category: params.policyType === "before_event" ? "pre_event" : (item.category ?? "today_focus"),
    policyType: params.policyType,
    timezone: item.timezone || params.timezone,
    startsAt: params.fireAt,
    nextFireAt: params.fireAt,
    requireAck: false,
    catchUpMode: "one_immediate_then_resume",
    idempotencyKey: `telegram-menu:${params.policyType}:${item.id}:${params.fireAt.toISOString()}`,
    metadata: {
      mutationSource: "user_natural_language",
      configuredFrom: "reminder_policy_menu",
    },
  });
  await materializeNextPolicyReminder(policy, params.fireAt);
  return policy;
}
