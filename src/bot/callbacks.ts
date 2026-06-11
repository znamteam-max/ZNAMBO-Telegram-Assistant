import type { Bot, InlineKeyboard } from "grammy";
import { DateTime } from "luxon";

import { renderScheduleViewTool, undoLastActionTool } from "@/agent/jarvisTools";
import { confirmPendingActionInDb, cancelPendingAction } from "@/db/queries/pendingActions";
import {
  cancelPlannerItem,
  getPlannerItemById,
  markPlannerItemCompleted,
  updatePlannerItemPriority,
} from "@/db/queries/items";
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
import { cancelActivePlanReset, executeActivePlanReset } from "@/services/activePlanReset";
import { UserFacingError } from "@/lib/errors";
import {
  createReminderPolicyIfMissing,
  getPolicyForReminder,
  stopPoliciesForItem,
  updatePoliciesPriorityForItem,
  updateReminderPolicy,
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

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import {
  afterEventKeyboard,
  beforeEventReminderMenuKeyboard,
  intervalReminderMenuKeyboard,
  itemMenuKeyboard,
  oneTimeReminderMenuKeyboard,
  policyFrequencyKeyboard,
  priorityEditorKeyboard,
  reminderPolicyMenuKeyboard,
  scheduleReminderMenuKeyboard,
  undoActionKeyboard,
} from "./keyboards";
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
      const sync = await syncPlannerItemToCalendar(result.item);
      const syncLine = sync.status === "synced" ? "\nКалендарь: синхронизировано." : "";

      await ctx.reply(`${formatCreatedItem(result.item, result.reminders.length)}${syncLine}`, {
        reply_markup: result.item.kind === "event" ? afterEventKeyboard(result.item.id) : undefined,
      });
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
      await ctx.reply(
        formatCommittedPlanSummary({
          items: result.items,
          reminderCount: result.reminders.length,
          timezone: owner.timezone,
        }),
      );
      await syncItemsToCalendarBestEffort(result.items);
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
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Напиши новое время для этой задачи одним сообщением. Например: перенеси на завтра 11:30.",
    );
  });

  bot.callbackQuery(/^manage:edit:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      item
        ? `Что изменить в «${item.title}»? Напиши одним сообщением, например: «перенеси на 15:00 и напомни за 30 минут».`
        : "Не нашёл эту запись.",
    );
  });

  bot.callbackQuery(/^manage:delete:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
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
    const sent = await ctx.reply(`${item.title}\n\nЧто делаем?`, {
      reply_markup: itemMenuKeyboard(item.id),
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
    await sendPolicyEditorMessage(ctx, "Выбери приоритет 1-5:", priorityEditorKeyboard("item", ctx.match[1]));
  });

  bot.callbackQuery(/^item:set_priority:(.+):([1-5])$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const updated = await updatePlannerItemPriority({
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
