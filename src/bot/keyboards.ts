import { InlineKeyboard, Keyboard } from "grammy";
import { DateTime } from "luxon";

import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { entityRefCallback, type EntityRef } from "@/domain/entityRefs";

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

export function entityListKeyboard(refs: EntityRef[], includeDashboardActions = false) {
  const keyboard = new InlineKeyboard();
  for (const [index, ref] of refs.slice(0, 12).entries()) {
    keyboard.text(String(index + 1), entityRefCallback(ref));
    if ((index + 1) % 4 === 0) keyboard.row();
  }
  if (refs.length % 4 !== 0) keyboard.row();
  if (includeDashboardActions) {
    keyboard
      .text("➕ Добавить", "dashboard:add")
      .text("🔔 Напоминания", "dashboard:reminders")
      .row()
      .text("📅 Дальние", "dashboard:longterm")
      .text("🧹 Очистить", "dashboard:cleanup");
  }
  return keyboard;
}

export function taskListKeyboard(refs: EntityRef[]) {
  const keyboard = entityListKeyboard(refs);
  return keyboard
    .row()
    .text("🗑 Удалить выбранные", "tasks:delete_help")
    .text("🧭 Разобрать старое", "tasks:review_old")
    .row()
    .text("🗄 Архив", "tasks:archive")
    .text("✅ Готово", "tasks:done_help")
    .row()
    .text("📋 План", "dashboard:refresh");
}

export function reminderEmptyKeyboard() {
  return new InlineKeyboard()
    .text("📋 План", "dashboard:refresh")
    .text("🧾 Задачи", "tasks:open")
    .row()
    .text("➕ Добавить напоминание", "reminders:add");
}

export function postCreateTriageKeyboard(items: PlannerItem[], now = new Date()) {
  if (items.length === 1 && items[0]?.dueAt && !items[0].startAt) {
    return deadlineReminderSuggestionKeyboard(items[0], now);
  }
  const keyboard = new InlineKeyboard();
  for (const [index, item] of items.slice(0, 8).entries()) {
    keyboard.text(String(index + 1), `entity:open:planner_item:${item.id}`);
    if ((index + 1) % 4 === 0) keyboard.row();
  }
  if (items.length % 4 !== 0) keyboard.row();
  return keyboard
    .text("⭐ Приоритеты", `triage:priority:${items[0]?.id ?? "none"}`)
    .text("🔔 Напоминания", `triage:reminders:${items[0]?.id ?? "none"}`)
    .row()
    .text("Оставить как есть", "triage:done");
}

export function safeMutationPreviewKeyboard(actionId: string) {
  return new InlineKeyboard()
    .text("Да, применить", `safe_mutation:confirm:${actionId}`)
    .text("Отмена", `safe_mutation:cancel:${actionId}`)
    .row()
    .text("Открыть список", "tasks:open");
}

export function itemEditPreviewKeyboard(actionId: string) {
  return new InlineKeyboard()
    .text("Применить", `item_edit:confirm:${actionId}`)
    .text("Отмена", `item_edit:cancel:${actionId}`)
    .row()
    .text("Открыть план", "dashboard:refresh");
}

export function conflictKeyboard(firstItemId: string, secondItemId: string) {
  return new InlineKeyboard()
    .text("Оставить оба", "conflict:keep")
    .row()
    .text("Перенести первое", `manage:reschedule:${firstItemId}`)
    .text("Перенести второе", `manage:reschedule:${secondItemId}`)
    .row()
    .text("Открыть оба", `conflict:open:${firstItemId}:${secondItemId}`);
}

export function repeatPolicyDeleteKeyboard(policyId: string, itemId?: string | null) {
  const keyboard = new InlineKeyboard().text(
    "Только правило",
    `policy:cancel_rule:${policyId}`,
  );
  if (itemId) keyboard.row().text("Задачу и правило", `policy:cancel_all:${policyId}:${itemId}`);
  return keyboard.row().text("Отмена", `policy:open:${policyId}`);
}

export function itemMenuKeyboard(
  itemId: string,
  campaignGroup?: string | null,
  calendarStatus?: string | null,
  deadlineOnly = false,
) {
  const keyboard = new InlineKeyboard()
    .text("✅ Выполнено", `done:${itemId}`)
    .text(deadlineOnly ? "🕘 Запланировать время" : "🕘 Время", `manage:reschedule:${itemId}`)
    .row()
    .text("✏️ Изменить", `manage:edit:${itemId}`)
    .text("🔔 Напоминание", `item:remind:${itemId}`)
    .row()
    .text("⭐ Важность", `item:priority:${itemId}`)
    .text("❗ Маркер", `item:marker:${itemId}`)
    .row()
    .text("🗑 Удалить", `manage:delete:${itemId}`);
  if (["failed", "error", "pending_retry"].includes(calendarStatus ?? "")) {
    keyboard.row().text("Повторить sync", `calendar:retry:${itemId}`);
  }
  if (campaignGroup) keyboard.row().text("📣 Кампания", `entity:open:campaign:${campaignGroup}`);
  return keyboard
    .row()
    .text("↩️ К плану", "dashboard:refresh")
    .text("⚙️ Ещё", `item:more:${itemId}`);
}

export function persistentMarkerKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("Авто", `item:set_marker:${itemId}:auto`)
    .text("Показывать", `item:set_marker:${itemId}:show`)
    .row()
    .text("Скрыть", `item:set_marker:${itemId}:hide`)
    .text("Назад", `entity:open:planner_item:${itemId}`);
}

export function deadlineReminderSuggestionKeyboard(item: PlannerItem, now = new Date()) {
  const timezone = item.timezone || "Europe/Moscow";
  const dueLocal = DateTime.fromJSDate(item.dueAt!, { zone: "utc" }).setZone(timezone);
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  const dueToday = dueLocal.hasSame(nowLocal, "day");
  return new InlineKeyboard()
    .text(
      dueToday ? "Скоро" : "Утром",
      `deadline_reminder:${dueToday ? "soon" : "morning"}:${item.id}`,
    )
    .text(
      dueToday ? "За час" : "За 2 часа",
      `deadline_reminder:${dueToday ? "1h" : "2h"}:${item.id}`,
    )
    .row()
    .text("За 30 минут", `deadline_reminder:30m:${item.id}`)
    .text("Не надо", `deadline_reminder:none:${item.id}`)
    .row()
    .text("Настроить", `deadline_reminder:custom:${item.id}`);
}

export function recurringTimeClarificationKeyboard(actionId: string, multiple = false) {
  const prefix = multiple ? "Оба в " : "";
  return new InlineKeyboard()
    .text(`${prefix}09:00`, `recurring_draft:time:09:00:${actionId}`)
    .text(`${prefix}12:00`, `recurring_draft:time:12:00:${actionId}`)
    .row()
    .text(`${prefix}18:00`, `recurring_draft:time:18:00:${actionId}`)
    .text("Указать", `recurring_draft:custom:${actionId}`)
    .row()
    .text("Отмена", `recurring_draft:cancel:${actionId}`);
}

export function recurringPolicyDuplicateKeyboard(actionId: string) {
  return new InlineKeyboard()
    .text("Обновить", `recurring_dup:update:${actionId}`)
    .text("Создать новое", `recurring_dup:new:${actionId}`)
    .row()
    .text("Отмена", `recurring_dup:cancel:${actionId}`);
}

export function completedItemsKeyboard(params: {
  items: PlannerItem[];
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
}) {
  const keyboard = new InlineKeyboard();
  for (const [index, item] of params.items.entries()) {
    keyboard.text(String(index + 1), `completed:open:${item.id}`);
  }
  if (params.items.length) keyboard.row();
  if (params.hasPrevious) keyboard.text("← Назад", `completed:page:${params.page - 1}`);
  if (params.hasNext) keyboard.text("Вперёд →", `completed:page:${params.page + 1}`);
  if (params.hasPrevious || params.hasNext) keyboard.row();
  return keyboard.text("План", "dashboard:refresh");
}

export function completedItemKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("↩️ Вернуть в активные", `completed:restore:${itemId}`)
    .row()
    .text("🗄 Оставить в архиве", `completed:archive:${itemId}`)
    .text("План", "dashboard:refresh");
}

export function cleanupPreviewKeyboard(chatId: string) {
  return new InlineKeyboard()
    .text("Preview: карточки чата", `cleanup:preview:chat:${chatId}`)
    .row()
    .text("Очистить карточки чата", `cleanup:confirm:chat:${chatId}`)
    .row()
    .text("Отмена", "cleanup:cancel");
}

export function itemMoreKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("Календарь / повторить sync", `calendar:retry:${itemId}`)
    .row()
    .text("Safe debug", `calendar:debug:${itemId}`)
    .text("Отключить sync", `calendar:disable:${itemId}`)
    .row()
    .text("История / Итоги", `item:results:${itemId}`)
    .text("Напоминания", `entity:item_policies:${itemId}`)
    .row()
    .text("Назад", `entity:open:planner_item:${itemId}`)
    .text("План", "dashboard:refresh");
}

export function externalCalendarEventKeyboard(eventId: string, recurring = false) {
  const keyboard = new InlineKeyboard()
    .text("🕘 Время", `external:edit:${eventId}`)
    .text("✏️ Изменить", `external:edit:${eventId}`)
    .row()
    .text("🗑 Удалить", `external:delete_prompt:${eventId}`)
    .text("Скрыть в JARVIS", `external:hide:${eventId}`);
  if (recurring) keyboard.row().text("Повторяющаяся серия", `external:recurring_info:${eventId}`);
  return keyboard.row().text("↩️ К плану", "dashboard:refresh");
}

export function externalCalendarDeleteKeyboard(eventId: string) {
  return new InlineKeyboard()
    .text("Удалить везде", `external:delete_everywhere:${eventId}`)
    .row()
    .text("Скрыть в JARVIS", `external:hide:${eventId}`)
    .text("Отмена", `entity:open:external:${eventId}`);
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
    .text("😴 30 мин", `reminder:snooze:${reminderId}:30`)
    .row()
    .text("😴 1 час", `reminder:snooze:${reminderId}:60`)
    .text("😴 2 часа", `reminder:snooze:${reminderId}:120`)
    .row()
    .text("😴 до завтра", `reminder:snooze_tomorrow:${reminderId}`)
    .row()
    .text("✏️ Изменить", `reminder:edit:${reminderId}`)
    .text("🔕 Остановить", `reminder:delete:${reminderId}`);
  if (plannerItemId) keyboard.row().text("🔙 К плану", "dashboard:refresh");
  return keyboard;
}

export function normalReminderMenuKeyboard(reminderId: string, plannerItemId: string) {
  return new InlineKeyboard()
    .text("✅ Сделал", `reminder:ack:${reminderId}`)
    .text("😴 1 час", `reminder:snooze:${reminderId}:60`)
    .row()
    .text("✏️ Изменить", `manage:edit:${plannerItemId}`)
    .text("🔙 К плану", "dashboard:refresh");
}

export function reminderPolicyMenuKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("⏰ В конкретное время", `policy_menu:once:${itemId}`)
    .text("📅 Перед событием", `policy_menu:before:${itemId}`)
    .row()
    .text("🔁 Повторять", `policy_menu:schedule:${itemId}`)
    .text("❗ Долбить, пока не выполню", `policy_menu:until:${itemId}`)
    .row()
    .text("➕ Несколько напоминаний", `policy_menu:multi:${itemId}`)
    .text("⚙️ Дополнительно", `policy_menu:custom:${itemId}`)
    .row()
    .text("⬅️ К плану", "dashboard:refresh");
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

export function reminderPolicyListKeyboard(policies: ReminderPolicy[]) {
  const keyboard = new InlineKeyboard();
  for (const [index, policy] of policies.slice(0, 12).entries()) {
    keyboard.text(String(index + 1), `policy:open:${policy.id}`);
    if ((index + 1) % 4 === 0) keyboard.row();
  }
  if (policies.length % 4 !== 0) keyboard.row();
  return keyboard
    .text("Активные", "policy:list:active")
    .text("Скоро", "policy:list:soon")
    .text("Дальние", "policy:list:distant")
    .row()
    .text("Долгосрочные", "policy:list:longterm")
    .text("На паузе", "policy:list:paused")
    .row()
    .text("План", "dashboard:refresh");
}

export function reminderPolicyCardKeyboard(policy: ReminderPolicy) {
  const keyboard = new InlineKeyboard()
    .text("Приоритет", `policy:priority:${policy.id}`)
    .text("Частота", `policy:frequency:${policy.id}`)
    .row();
  if (policy.status === "active") {
    keyboard.text("Пауза", `policy:pause:${policy.id}`);
  } else {
    keyboard.text("Возобновить", `policy:resume:${policy.id}`);
  }
  keyboard
    .text("Удалить", `policy:cancel:${policy.id}`)
    .row();
  if (policy.itemId) keyboard.text("Связанная запись", `entity:open:planner_item:${policy.itemId}`).row();
  const campaignGroup = String(policy.metadata?.campaignGroup ?? "");
  if (campaignGroup) keyboard.text("Кампания", `entity:open:campaign:${campaignGroup}`).row();
  return keyboard.text("Назад", "policy:list:active").text("План", "dashboard:refresh");
}

export function priorityEditorKeyboard(target: "item" | "policy", id: string) {
  if (target === "item") {
    return new InlineKeyboard()
      .text("Без значка", `item:set_importance:${id}:none`)
      .row()
      .text("⭐ Важно", `item:set_importance:${id}:important`)
      .text("🔥 Очень важно", `item:set_importance:${id}:very_important`)
      .row()
      .text("Авто", `item:set_importance:${id}:auto`)
      .row()
      .text("Назад", `entity:open:planner_item:${id}`);
  }
  const keyboard = new InlineKeyboard();
  for (const [priority, label] of [
    [1, "Низкая"],
    [2, "Ниже обычной"],
    [3, "Обычная"],
    [4, "Важная"],
    [5, "Очень важная"],
  ] as const) {
    keyboard.text(label, `${target}:set_priority:${id}:${priority}`).row();
  }
  return keyboard.text("Назад", target === "policy" ? `policy:open:${id}` : `entity:open:planner_item:${id}`);
}

export function campaignCardKeyboard(campaignGroup: string) {
  return new InlineKeyboard()
    .text("▶️ Активировать следующий", `campaign:activate:${campaignGroup}`)
    .row()
    .text("⏸ Пауза", `campaign:pause:${campaignGroup}`)
    .text("▶️ Возобновить", `campaign:resume:${campaignGroup}`)
    .row()
    .text("⭐ Важность", `campaign:priority:${campaignGroup}`)
    .text("🗑 Удалить", `campaign:cancel:${campaignGroup}`)
    .row()
    .text("🔙 К плану", "dashboard:refresh");
}

export function campaignCompletionGuardKeyboard(itemId: string) {
  return new InlineKeyboard()
    .text("Подготовка выполнена", `campaign:prep_done:${itemId}`)
    .row()
    .text("Событие уже прошло", `campaign:event_passed:${itemId}`)
    .text("Отменить событие", `manage:delete:${itemId}`)
    .row()
    .text("Перенести", `manage:reschedule:${itemId}`)
    .text("Назад", `entity:open:campaign_item:${itemId}`);
}

export function policyFrequencyKeyboard(policyId: string) {
  const keyboard = new InlineKeyboard();
  for (const minutes of [5, 10, 15, 20, 30, 45, 60, 120, 180, 240, 300]) {
    keyboard.text(minutes < 60 ? `${minutes} мин` : `${minutes / 60} ч`, `policy:set_interval:${policyId}:${minutes}`);
    if ([15, 45, 180].includes(minutes)) keyboard.row();
  }
  return keyboard.row().text("Назад", `policy:open:${policyId}`);
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

export function navigationKeyboard() {
  return new Keyboard()
    .text("🏠 План")
    .text("➕ Добавить")
    .row()
    .text("✅ Задачи")
    .text("🔔 Напоминания")
    .row()
    .text("✅ Выполненные")
    .text("🧹 Очистить")
    .row()
    .text("⚙️ Настройки")
    .resized()
    .persistent();
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
