import type { PlannerItem } from "@/db/schema";

const kindOrder: Record<string, number> = {
  event: 1,
  training: 2,
  task: 3,
  preparation_task: 4,
  note: 5,
};

export function sortPlannerItemsForAgenda<
  T extends Pick<PlannerItem, "kind" | "startAt" | "dueAt" | "createdAt">,
>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aTime = (a.startAt ?? a.dueAt ?? a.createdAt).getTime();
    const bTime = (b.startAt ?? b.dueAt ?? b.createdAt).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return (kindOrder[a.kind] ?? 99) - (kindOrder[b.kind] ?? 99);
  });
}
