import { DateTime } from "luxon";

import type { PlannerItem } from "@/db/schema";

const kindLabels: Record<string, string> = {
  event: "Встреча",
  task: "Задача",
  training: "Тренировка",
  note: "Заметка",
  preparation_task: "Подготовка",
  tentative_event: "Под вопросом",
  recurring_task: "Повтор",
};

export function sortJarvisItemsForDisplay(items: PlannerItem[]): PlannerItem[] {
  return [...items].sort((a, b) => {
    const aTime = (a.startAt ?? a.dueAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bTime = (b.startAt ?? b.dueAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (aTime !== bTime) return aTime - bTime;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

export function renderNumberedTaskView(params: {
  title: string;
  items: PlannerItem[];
  timezone: string;
  intro?: string;
  emptyText?: string;
  footer?: string;
}): string {
  if (!params.items.length) {
    return `${params.title}\n\n${params.emptyText ?? "Пока пусто."}`;
  }

  const lines = [params.title];
  if (params.intro) lines.push("", params.intro);

  const sections = groupItems(params.items);
  for (const [section, items] of sections) {
    if (!items.length) continue;
    lines.push("", `${section}:`);
    for (const item of items) {
      lines.push(formatNumberedItem(item, params.timezone));
    }
  }

  if (params.footer) lines.push("", params.footer);
  return lines.join("\n");
}

export function formatNumberedItem(item: PlannerItem, timezone: string): string {
  const displayIndex = Number(item.metadata?.displayIndex);
  const indexPrefix = Number.isFinite(displayIndex) && displayIndex > 0 ? `${displayIndex}. ` : "";
  const when = formatWhen(item, timezone);
  const flags = [
    isTentative(item) ? "предварительно" : null,
    isFloating(item) ? "без точного времени" : null,
    item.status === "completed" ? "выполнено" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const flagText = flags ? ` (${flags})` : "";
  return `${indexPrefix}${kindLabels[item.kind] ?? item.kind}: ${item.title}${when ? ` — ${when}` : ""}${flagText}`;
}

function groupItems(items: PlannerItem[]): Array<[string, PlannerItem[]]> {
  const now = Date.now();
  const overdue: PlannerItem[] = [];
  const scheduled: PlannerItem[] = [];
  const recurring: PlannerItem[] = [];
  const training: PlannerItem[] = [];
  const floating: PlannerItem[] = [];
  const notes: PlannerItem[] = [];

  for (const item of items) {
    const when = item.startAt ?? item.dueAt;
    if (item.kind === "recurring_task") recurring.push(item);
    else if (item.kind === "training") training.push(item);
    else if (item.kind === "note") notes.push(item);
    else if (when && when.getTime() < now && item.status === "active") overdue.push(item);
    else if (!when || isFloating(item)) floating.push(item);
    else scheduled.push(item);
  }

  return [
    ["Просрочено", overdue],
    ["Расписание", scheduled],
    ["Тренировки", training],
    ["Повторяющиеся", recurring],
    ["Без времени", floating],
    ["Заметки", notes],
  ];
}

function formatWhen(item: PlannerItem, timezone: string): string {
  const when = item.startAt ?? item.dueAt;
  if (!when) return "";
  const zone = item.timezone || timezone;
  const start = DateTime.fromJSDate(when, { zone: "utc" }).setZone(zone).setLocale("ru");
  if (!start.isValid) return "";
  const end = item.endAt
    ? DateTime.fromJSDate(item.endAt, { zone: "utc" }).setZone(zone).setLocale("ru")
    : null;
  const base = start.toFormat("dd.LL HH:mm");
  return end?.isValid ? `${base}-${end.toFormat("HH:mm")}` : base;
}

function isTentative(item: PlannerItem) {
  return item.kind === "tentative_event" || item.metadata?.tentative === true || item.metadata?.tentativeTrainingPlan === true;
}

function isFloating(item: PlannerItem) {
  return item.metadata?.isFloating === true || item.metadata?.timeUnspecified === true;
}
