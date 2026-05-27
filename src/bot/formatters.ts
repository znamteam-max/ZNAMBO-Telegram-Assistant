import { DateTime } from "luxon";

import type { PlannerActionProposal } from "@/ai/schemas";
import type { PlannerItem, Reminder } from "@/db/schema";
import { formatLocalDateRange, formatLocalDateTime } from "@/domain/dateTime";

const kindLabels: Record<string, string> = {
  event: "Встреча",
  task: "Задача",
  training: "Тренировка",
  note: "Заметка",
  preparation_task: "Подготовка",
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

function formatProposalLocalTime(localIso: string | null | undefined, timezone: string): string {
  if (!localIso) return "без времени";
  const dt = DateTime.fromISO(localIso, { zone: timezone }).setLocale("ru");
  if (!dt.isValid) return localIso;
  return dt.toLocaleString(DateTime.DATETIME_MED);
}
