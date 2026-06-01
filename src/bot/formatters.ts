import { DateTime } from "luxon";

import type { ActionPlan, ActionPlanItem } from "@/ai/schemas";
import type { PlannerActionProposal } from "@/ai/schemas";
import type { PlannerItem, Reminder } from "@/db/schema";
import { formatLocalDateRange, formatLocalDateTime } from "@/domain/dateTime";

const kindLabels: Record<string, string> = {
  event: "Встреча",
  task: "Задача",
  training: "Тренировка",
  note: "Заметка",
  preparation_task: "Подготовка",
  tentative_event: "Под вопросом",
  recurring_task: "Повтор",
};

const actionSectionLabels: Record<string, string> = {
  event: "Встречи",
  preparation: "Подготовка",
  tentative_event: "Под вопросом",
  training: "Тренировка",
  recurring_task: "Повторяющиеся напоминания",
  task: "Задачи",
  reminder: "Напоминания",
  note: "Заметки",
  followup: "Follow-up",
};

export function formatProposalCard(proposal: PlannerActionProposal, timezone: string): string {
  const title = proposal.title ?? "Без названия";
  const kind = proposal.kind ? kindLabels[proposal.kind] : "Запись";
  const time =
    proposal.startAtLocal || proposal.dueAtLocal
      ? formatProposalLocalTime(
          proposal.startAtLocal ?? proposal.dueAtLocal,
          proposal.timezone ?? timezone,
        )
      : "без времени";
  const reminders = proposal.reminderPresets.length
    ? proposal.reminderPresets.join(", ")
    : "по умолчанию";

  return [
    `${kind}: ${title}`,
    `Когда: ${time}`,
    proposal.location ? `Где: ${proposal.location}` : null,
    proposal.description ? `Детали: ${proposal.description}` : null,
    `Напоминания: ${reminders}`,
    "",
    "Сохранить эту запись?",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatCreatedItem(item: PlannerItem, reminderCount: number): string {
  const time = formatLocalDateRange(item.startAt, item.endAt ?? item.dueAt, item.timezone);
  const reminderLine =
    reminderCount > 0 ? `Напоминаний: ${reminderCount}.` : "Будущих напоминаний не добавлял.";
  return `✅ Записал: ${item.title}\n${time}\n${reminderLine}`;
}

export function formatActionPlanCard(plan: ActionPlan, timezone: string): string {
  if (plan.intent === "answer") return plan.reply || "Покажу через команды расписания.";
  if (plan.intent === "clarify") {
    const questions = plan.clarificationQuestions.length
      ? `\n${plan.clarificationQuestions.map((question) => `• ${question}`).join("\n")}`
      : "";
    return `${plan.reply || "Нужно уточнение."}${questions}`;
  }

  const grouped = groupActions(plan.actions);
  const lines = ["Разложил сообщение:"];
  for (const [section, actions] of grouped) {
    lines.push("", `${actionSectionLabels[section] ?? section}:`);
    for (const action of actions) {
      lines.push(`• ${formatActionPlanItem(action, timezone)}`);
    }
  }

  const reminderCount = plan.actions.reduce((count, action) => count + action.reminders.length, 0);
  if (reminderCount) {
    lines.push("", `Напоминания поставлю: ${reminderCount}.`);
  }
  if (plan.requiresConfirmation) {
    lines.push("", "Сохранить этот план?");
  }
  return lines.join("\n");
}

export function formatCommittedPlanSummary(params: {
  items: PlannerItem[];
  reminderCount: number;
  timezone: string;
}) {
  const lines = ["✅ Записал:"];
  for (const item of params.items) {
    const when = formatLocalDateRange(item.startAt, item.endAt ?? item.dueAt, item.timezone || params.timezone);
    lines.push(`• ${kindLabels[item.kind] ?? item.kind}: ${item.title} — ${when}`);
  }
  lines.push(
    params.reminderCount
      ? `Напоминаний создано: ${params.reminderCount}.`
      : "Будущих напоминаний не добавлял.",
  );
  lines.push("Можно прислать уточнение голосом или отметить задачи в /tasks.");
  return lines.join("\n");
}

export function formatItemList(title: string, items: PlannerItem[], timezone: string): string {
  if (!items.length) return `${title}\n\nПусто.`;
  const lines = items.map((item) => {
    const date = formatLocalDateTime(item.startAt ?? item.dueAt, item.timezone || timezone);
    const icon = item.kind === "event" ? "•" : item.kind === "training" ? "•" : "•";
    return `${icon} ${date} — ${kindLabels[item.kind] ?? item.kind}: ${item.title}`;
  });
  return `${title}\n\n${lines.join("\n")}`;
}

export function formatReminderMessage(reminder: Reminder, item?: PlannerItem | null): string {
  if (!item) return "Напоминание.";
  const when = formatLocalDateRange(item.startAt, item.endAt ?? item.dueAt, item.timezone);
  if (reminder.repeatUntilAck || item.kind === "recurring_task") {
    return `Повторяющееся напоминание: ${item.title}\n${when}\n\nНажми кнопку, чтобы я понял, что делать дальше.`;
  }
  if (reminder.type === "followup") {
    return `Как прошла встреча: ${item.title}?\n\nМожешь голосом надиктовать итоги, а я выделю новые задачи.`;
  }
  if (reminder.type === "training_followup") {
    return `Как прошла тренировка: ${item.title}?\n\nМожно коротко записать ощущения и что скорректировать.`;
  }
  if (reminder.type === "task_overdue") {
    return `Проверка задачи: ${item.title}\nСрок был: ${when}`;
  }
  return `Напоминание: ${item.title}\n${when}`;
}

function groupActions(actions: ActionPlanItem[]) {
  const groups = new Map<string, ActionPlanItem[]>();
  for (const action of actions) {
    const key = action.actionType;
    groups.set(key, [...(groups.get(key) ?? []), action]);
  }
  return [...groups.entries()];
}

function formatActionPlanItem(action: ActionPlanItem, timezone: string): string {
  const localTime = action.startAtLocal ?? action.dueAtLocal;
  const when = localTime ? formatProposalLocalTime(localTime, action.timezone ?? timezone) : "без времени";
  const tentative = action.tentative ? "tentative: " : "";
  const recurrence = action.recurrence
    ? `; повтор ${action.recurrence.daysOfWeek.join(",") || action.recurrence.frequency} ${action.recurrence.timeLocal ?? ""}`.trim()
    : "";
  return `${when} — ${tentative}${action.title}${action.description ? ` (${action.description})` : ""}${recurrence}`;
}

function formatProposalLocalTime(localIso: string | null | undefined, timezone: string): string {
  if (!localIso) return "без времени";
  const dt = DateTime.fromISO(localIso, { zone: timezone }).setLocale("ru");
  if (!dt.isValid) return localIso;
  return dt.toLocaleString(DateTime.DATETIME_MED);
}
