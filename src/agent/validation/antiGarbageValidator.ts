import type { PlannerItem } from "@/db/schema";

const managementTitlePattern =
  /(дай\s+план|план\s+целиком|удали\s+\d|удалить\s+\d|отметить\s+что\s+выполнено|покажи\s+задачи|открой\s+задачи|cleanup garbage)/i;

export function isLikelyGarbagePlannerItem(item: Pick<PlannerItem, "title" | "metadata" | "kind">): boolean {
  const title = item.title.trim();
  const metadata = item.metadata ?? {};
  if (metadata.debug === true || metadata.command === "remindertest") return true;
  if (managementTitlePattern.test(title)) return true;
  if (title.length > 220 && /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+/m.test(title)) return true;
  if (item.kind === "task" && /^(хочу\s+отметить|дай\s+план|покажи\s+план)/i.test(title)) return true;
  return false;
}

export function explainGarbageItem(item: Pick<PlannerItem, "title" | "metadata" | "kind">): string {
  const metadata = item.metadata ?? {};
  if (metadata.debug === true || metadata.command === "remindertest") return "debug/test item";
  if (managementTitlePattern.test(item.title)) return "management command saved as item";
  if (item.title.length > 220) return "oversized list-like title";
  return "likely garbage";
}
