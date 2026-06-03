import type { PlannerItem } from "@/db/schema";

import { renderNumberedTaskView } from "./renderShared";

export function renderFullPlan(params: {
  items: PlannerItem[];
  timezone: string;
}): string {
  return renderNumberedTaskView({
    title: "План целиком",
    items: params.items,
    timezone: params.timezone,
    intro: "Ничего нового не создаю. Показываю текущую картину, по номерам можно удалять или отмечать выполненным.",
    emptyText: "Пока нет активных встреч, задач, тренировок или повторяющихся напоминаний.",
    footer: "Можно написать: удалить 7-12 и 14, отметить 2 и 5 выполненными, или почисти мусор.",
  });
}
