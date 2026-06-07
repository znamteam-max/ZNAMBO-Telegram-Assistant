import type { ActionPlan, ActionPlanItem } from "@/ai/schemas";
import { listVisibleActivePlanItems } from "@/db/queries/items";
import type { PlannerItem } from "@/db/schema";
import { localIsoToUtcDate } from "@/domain/dateTime";
import { DateTime } from "luxon";

export async function filterDuplicateActionPlan(params: {
  userId: string;
  timezone: string;
  plan: ActionPlan;
}) {
  if (!params.plan.actions.length) {
    return { plan: params.plan, skippedItemIds: [] as string[], warnings: [] as string[] };
  }

  const existing = await listVisibleActivePlanItems(params.userId, 200);
  const accepted: ActionPlanItem[] = [];
  const skippedItemIds: string[] = [];
  const warnings: string[] = [];
  const seenProposalKeys = new Set<string>();

  for (const action of params.plan.actions) {
    const proposalKey = actionKey(action, params.timezone);
    if (seenProposalKeys.has(proposalKey)) {
      warnings.push(`duplicate_action_in_plan_skipped:${action.title}`);
      continue;
    }
    seenProposalKeys.add(proposalKey);

    const duplicate = existing.find((item) => isSamePlannerEntry(item, action, params.timezone));
    if (duplicate) {
      skippedItemIds.push(duplicate.id);
      warnings.push(`duplicate_existing_item_skipped:${duplicate.id}`);
      continue;
    }
    accepted.push(action);
  }

  return {
    plan: { ...params.plan, actions: accepted },
    skippedItemIds: [...new Set(skippedItemIds)],
    warnings: [...new Set(warnings)],
  };
}

function isSamePlannerEntry(
  item: PlannerItem,
  action: ActionPlanItem,
  defaultTimezone: string,
) {
  if (normalizeTitle(item.title) !== normalizeTitle(action.title)) return false;
  const existingWhen = item.startAt ?? item.dueAt;
  const proposedWhen = action.startAtLocal
    ? localIsoToUtcDate(action.startAtLocal, action.timezone || defaultTimezone)
    : action.dueAtLocal
      ? localIsoToUtcDate(action.dueAtLocal, action.timezone || defaultTimezone)
      : null;
  if (!existingWhen && !proposedWhen) return true;
  if (!existingWhen || !proposedWhen) return false;
  if (
    ["task", "preparation_task", "recurring_task"].includes(item.kind) &&
    DateTime.fromJSDate(existingWhen, { zone: "utc" })
      .setZone(item.timezone || defaultTimezone)
      .toISODate() ===
      DateTime.fromJSDate(proposedWhen, { zone: "utc" })
        .setZone(action.timezone || defaultTimezone)
        .toISODate()
  ) {
    return true;
  }
  return Math.abs(existingWhen.getTime() - proposedWhen.getTime()) <= 5 * 60 * 1000;
}

function actionKey(action: ActionPlanItem, defaultTimezone: string) {
  const when = action.startAtLocal
    ? localIsoToUtcDate(action.startAtLocal, action.timezone || defaultTimezone).toISOString()
    : action.dueAtLocal
      ? localIsoToUtcDate(action.dueAtLocal, action.timezone || defaultTimezone).toISOString()
      : "no-time";
  return `${normalizeTitle(action.title)}:${when}`;
}

function normalizeTitle(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
