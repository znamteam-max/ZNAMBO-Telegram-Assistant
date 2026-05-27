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
