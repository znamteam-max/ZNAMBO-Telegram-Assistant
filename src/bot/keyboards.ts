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
