import type { PlannerItem } from "@/db/schema";

import { renderNumberedTaskView } from "./renderShared";

export function renderToday(params: {
  title?: string;
  items: PlannerItem[];
  timezone: string;
}): string {
  return renderNumberedTaskView({
    title: params.title ?? "Сегодня",
    items: params.items,
    timezone: params.timezone,
    intro: "Показываю расписание, открытые задачи, тренировки, повторы и просроченное.",
    emptyText: "На этот день пока ничего не записано.",
    footer: "Номера в списке можно использовать в следующих сообщениях.",
  });
}
