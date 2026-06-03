import type { PlannerItem } from "@/db/schema";

import { renderNumberedTaskView } from "./renderShared";

export function renderYesterdayReview(params: {
  items: PlannerItem[];
  timezone: string;
}): string {
  return renderNumberedTaskView({
    title: "Разбор вчера",
    items: params.items,
    timezone: params.timezone,
    intro: "Открыл вчерашние записи. Ничего нового не создаю: можно ответить номерами, что выполнено, что удалить или перенести.",
    emptyText: "За вчера нет записей для разбора.",
    footer: "Например: выполнено 1, 3 и 4. Или: удалить 2.",
  });
}
