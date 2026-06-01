import { InlineKeyboard } from "grammy";

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
