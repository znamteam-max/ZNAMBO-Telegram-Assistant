import { InlineKeyboard } from "grammy";

import type { PlannerItem } from "@/db/schema";

export function pendingActionKeyboard(pendingActionId: string) {
  return new InlineKeyboard()
    .text("Подтвердить", `pa:ok:${pendingActionId}`)
    .text("Изменить", `pa:edit:${pendingActionId}`)
    .text("Отменить", `pa:no:${pendingActionId}`);
}

export function afterEventKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("Добавить подготовку", `prep:${itemId}`)
    .text("Нет", "noop")
    .text("Предложи чек-лист", `checklist:${itemId}`);
}

export function itemActionKeyboard(itemId: string, kind: string) {
  const keyboard = new InlineKeyboard();
  if (kind === "task" || kind === "preparation_task") keyboard.text("Сделано", `done:${itemId}`);
  if (kind === "event") keyboard.text("Подготовка", `prep:${itemId}`);
  if (kind === "training") keyboard.text("План тренировки", `training:${itemId}`);
  return keyboard;
}

export function taskManagementKeyboard(items: PlannerItem[]) {
  const keyboard = new InlineKeyboard();
  for (const [index, item] of items.slice(0, 5).entries()) {
    const label = String(index + 1);
    keyboard
      .text(`Готово ${label}`, `done:${item.id}`)
      .text(`Перенести ${label}`, `manage:reschedule:${item.id}`)
      .text(`Удалить ${label}`, `manage:delete:${item.id}`)
      .text(`Изменить ${label}`, `manage:edit:${item.id}`)
      .row();
  }
  keyboard
    .text("Изменить время", "manage:bulk_time")
    .text("Добавить напоминание", "manage:bulk_reminder")
    .row()
    .text("Скрыть", "noop");
  return keyboard;
}

export function singleItemManagementKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("Готово", `done:${itemId}`)
    .text("Перенести", `manage:reschedule:${itemId}`)
    .row()
    .text("Изменить", `manage:edit:${itemId}`)
    .text("Удалить", `manage:delete:${itemId}`);
}

export function liveDashboardKeyboard(items: PlannerItem[]) {
  const keyboard = new InlineKeyboard();
  for (const [index, item] of items.slice(0, 7).entries()) {
    keyboard.text(String(index + 1), `dashboard:item:${item.id}`);
  }
  if (items.length) keyboard.row();
  return keyboard
    .text("➕ Добавить", "dashboard:add")
    .text("🔔 Напоминания", "dashboard:reminders")
    .row()
    .text("📅 Дальние", "dashboard:longterm")
    .text("🧹 Очистить", "dashboard:cleanup");
}

export function itemMenuKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("✅ Выполнено", `done:${itemId}`)
    .text("⏭ Перенести", `manage:reschedule:${itemId}`)
    .row()
    .text("✏️ Изменить", `manage:edit:${itemId}`)
    .text("🗑 Удалить", `manage:delete:${itemId}`)
    .row()
    .text("🔔 Напомнить", `item:remind:${itemId}`)
    .text("📝 Итоги", `item:results:${itemId}`)
    .row()
    .text("🔙 К плану", "dashboard:refresh");
}

export function eventReactionKeyboard(itemId: string, kind = "event") {
  const doneLabel = kind === "training" ? "✅ Сделал" : "✅ Завершено";
  return new InlineKeyboard()
    .text(doneLabel, `done:${itemId}`)
    .text(kind === "tentative_event" ? "❌ Не было" : "❌ Отменить", `manage:delete:${itemId}`)
    .row()
    .text("⏭ Перенести", `manage:reschedule:${itemId}`)
    .text(kind === "training" ? "📊 Результат" : "📝 Итоги", `item:results:${itemId}`)
    .row()
    .text("✏️ Изменить", `manage:edit:${itemId}`)
    .text("🔙 План", "dashboard:refresh");
}

export function reminderMenuKeyboard(reminderId: string, plannerItemId?: string | null) {
  const keyboard = new InlineKeyboard()
    .text("✅ Сделал", `reminder:ack:${reminderId}`)
    .text("10 мин", `reminder:snooze:${reminderId}:10`)
    .text("30 мин", `reminder:snooze:${reminderId}:30`)
    .row()
    .text("1 час", `reminder:snooze:${reminderId}:60`)
    .text("До вечера", `reminder:snooze_evening:${reminderId}`)
    .text("На завтра", `reminder:snooze_tomorrow:${reminderId}`)
    .row()
    .text("🛠 Изменить", `reminder:edit:${reminderId}`)
    .text("🔕 Остановить", `reminder:delete:${reminderId}`);
  if (plannerItemId) keyboard.row().text("🔙 К плану", "dashboard:refresh");
  return keyboard;
}

export function reminderPolicyMenuKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("⏰ Один раз", `policy_menu:once:${itemId}`)
    .text("⏪ До события", `policy_menu:before:${itemId}`)
    .row()
    .text("🔁 Через интервалы", `policy_menu:interval:${itemId}`)
    .text("📆 По расписанию", `policy_menu:schedule:${itemId}`)
    .row()
    .text("✅ Пока не выполню", `policy_menu:until:${itemId}`)
    .text("🌙 Тихие часы", `policy_menu:quiet:${itemId}`)
    .row()
    .text("📂 Категория", `policy_menu:category:${itemId}`)
    .text("🛠 Свои настройки", `policy_menu:custom:${itemId}`)
    .row()
    .text("🔙 К плану", "dashboard:refresh");
}

export function oneTimeReminderMenuKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("Через 10 минут", `policy_once:${itemId}:10`)
    .text("Через 30 минут", `policy_once:${itemId}:30`)
    .row()
    .text("Через час", `policy_once:${itemId}:60`)
    .text("Сегодня вечером", `policy_once_evening:${itemId}`)
    .row()
    .text("Завтра утром", `policy_once_tomorrow:${itemId}`)
    .text("Дата и время", `policy_menu:custom:${itemId}`)
    .row()
    .text("🔙 Назад", `policy_menu:root:${itemId}`);
}

export function beforeEventReminderMenuKeyboard(itemId: string) {
  const keyboard = new InlineKeyboard();
  for (const minutes of [5, 15, 30, 60, 120, 1440]) {
    const label =
      minutes === 60
        ? "За час"
        : minutes === 120
          ? "За 2 часа"
          : minutes === 1440
            ? "За день"
            : `За ${minutes} мин`;
    keyboard.text(label, `policy_before:${itemId}:${minutes}`);
    if (minutes === 15 || minutes === 60 || minutes === 1440) keyboard.row();
  }
  return keyboard
    .text("За день + за час", `policy_before_multi:${itemId}`)
    .row()
    .text("🔙 Назад", `policy_menu:root:${itemId}`);
}

export function intervalReminderMenuKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("Каждые 10 мин", `policy_interval:${itemId}:10`)
    .text("Каждые 15 мин", `policy_interval:${itemId}:15`)
    .row()
    .text("Каждые 30 мин", `policy_interval:${itemId}:30`)
    .text("Каждый час", `policy_interval:${itemId}:60`)
    .row()
    .text("Свой интервал", `policy_menu:custom:${itemId}`)
    .row()
    .text("🔙 Назад", `policy_menu:root:${itemId}`);
}

export function scheduleReminderMenuKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("Каждый день", `policy_schedule:${itemId}:daily`)
    .text("По будням", `policy_schedule:${itemId}:weekdays`)
    .row()
    .text("Раз в неделю", `policy_schedule:${itemId}:weekly`)
    .text("Раз в 2 недели", `policy_schedule:${itemId}:every_2_weeks`)
    .row()
    .text("Раз в месяц", `policy_schedule:${itemId}:monthly`)
    .text("Раз в год", `policy_schedule:${itemId}:yearly`)
    .row()
    .text("Своё правило", `policy_menu:custom:${itemId}`)
    .row()
    .text("🔙 Назад", `policy_menu:root:${itemId}`);
}

export function reminderPolicyRepairKeyboard() {
  return new InlineKeyboard()
    .text("Конвертировать", "repair_policies:apply")
    .text("Показать детали", "repair_policies:preview")
    .row()
    .text("Архивировать вручную", "repair_policies:manual");
}

export function tentativeEventFollowupKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("Был", `tentative:happened:${itemId}`)
    .text("Не было", `tentative:skipped:${itemId}`)
    .row()
    .text("Перенести", `tentative:reschedule:${itemId}`)
    .text("Записать итоги", `tentative:notes:${itemId}`);
}

export function reminderActionKeyboard(reminderId: string, plannerItemId?: string | null) {
  const keyboard = new InlineKeyboard()
    .text("Готово на сегодня", `reminder:ack:${reminderId}`)
    .row()
    .text("Напомни через час", `reminder:snooze:${reminderId}:60`)
    .text("Пропустить сегодня", `reminder:skip:${reminderId}`)
    .row();

  if (plannerItemId) {
    keyboard.text("Больше не напоминать", `item:stop_recurring:${plannerItemId}`);
  }

  return keyboard;
}

export function actionPlanKeyboard(planId: string) {
  return new InlineKeyboard()
    .text("ОК", `plan:confirm:${planId}`)
    .text("Изменить", `plan:edit:${planId}`)
    .row()
    .text("Отменить", `plan:cancel:${planId}`);
}

export function calendarConnectKeyboard(url: string) {
  return new InlineKeyboard().url("Подключить Google Calendar", url);
}

export function startKeyboard(calendarLink?: { label: string; url: string }) {
  const keyboard = new InlineKeyboard()
    .text("Всё верно", "tz:ok")
    .text("Изменить часовой пояс", "tz:edit")
    .row();

  if (calendarLink) {
    keyboard.url(calendarLink.label, calendarLink.url);
  }

  return keyboard;
}

export function memoryDeleteKeyboard(memoryId: string) {
  return new InlineKeyboard().text("Удалить из памяти", `forget:${memoryId}`);
}

export function resetActivePlanKeyboard(actionId: string) {
  return new InlineKeyboard()
    .text("Да, очистить", `reset:confirm:${actionId}`)
    .row()
    .text("Только мусор и тестовые", `reset:garbage:${actionId}`)
    .row()
    .text("Показать список", "reset:show")
    .text("Отмена", `reset:cancel:${actionId}`);
}

export function undoActionKeyboard() {
  return new InlineKeyboard().text("Отменить последнее действие", "agent:undo");
}
