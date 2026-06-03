import type { PlannerItem } from "@/db/schema";

import { renderNumberedTaskView } from "./renderShared";

export function renderEveningReview(params: {
  items: PlannerItem[];
  timezone: string;
}): string {
  return renderNumberedTaskView({
    title: "Вечерняя проверка",
    items: params.items,
    timezone: params.timezone,
    intro: "Собрал то, что осталось открытым или требует отметки. Это режим управления, не создание задач.",
    emptyText: "Открытых дел для вечерней проверки нет.",
    footer: "Можно коротко: готово 1-3, удалить 4, отложить 5 на завтра.",
  });
}
