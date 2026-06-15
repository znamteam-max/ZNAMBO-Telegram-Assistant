import { DateTime } from "luxon";

import { completedItemsKeyboard } from "@/bot/keyboards";
import {
  archiveCompletedPlannerItem,
  listCompletedPlannerItems,
  restoreCompletedPlannerItem,
} from "@/db/queries/items";
import type { PlannerItem } from "@/db/schema";
import { formatRuWeekdayDateTime } from "@/domain/dateTime";

const PAGE_SIZE = 5;

export async function renderCompletedItemsView(params: {
  userId: string;
  timezone: string;
  page?: number;
}) {
  const page = Math.max(0, params.page ?? 0);
  const rows = await listCompletedPlannerItems({
    userId: params.userId,
    limit: PAGE_SIZE + 1,
    offset: page * PAGE_SIZE,
  });
  const items = rows.slice(0, PAGE_SIZE);
  const hasNext = rows.length > PAGE_SIZE;
  const hasPrevious = page > 0;
  const lines = ["✅ Выполненные", ""];
  if (!items.length) {
    lines.push(page > 0 ? "На этой странице пусто." : "Выполненных записей пока нет.");
  } else {
    lines.push(...items.map((item, index) => `${index + 1}. ${formatCompletedItem(item, params.timezone)}`));
  }
  lines.push("", "Можно открыть запись по номеру и вернуть её в активные.");
  return {
    text: lines.join("\n"),
    keyboard: completedItemsKeyboard({ items, page, hasNext, hasPrevious }),
    items,
  };
}

export async function restoreCompletedItem(params: { userId: string; itemId: string }) {
  return restoreCompletedPlannerItem(params);
}

export async function archiveCompletedItem(params: { userId: string; itemId: string }) {
  return archiveCompletedPlannerItem(params);
}

function formatCompletedItem(item: PlannerItem, timezone: string) {
  const completed = item.completedAt
    ? DateTime.fromJSDate(item.completedAt, { zone: "utc" })
        .setZone(item.timezone || timezone)
        .toFormat("dd.MM HH:mm")
    : "без даты";
  const originalTime = item.startAt ?? item.dueAt;
  const original = originalTime
    ? ` · было ${formatRuWeekdayDateTime(originalTime, item.timezone || timezone)}`
    : "";
  return `${item.title} — закрыто ${completed}${original}`;
}
