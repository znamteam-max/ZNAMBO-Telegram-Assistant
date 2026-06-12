import { and, desc, eq, gt, inArray } from "drizzle-orm";

import { getDb } from "../client";
import { plannerItems, taskViewStates, type PlannerItem, type TaskViewState } from "../schema";

export type TaskViewScope =
  | "current"
  | "dashboard"
  | "today"
  | "tomorrow"
  | "week"
  | "recent_range"
  | "yesterday_review"
  | "evening_review"
  | "reset_preview"
  | "cleanup";

export type TaskViewItemSnapshot = {
  displayIndex: number;
  itemId: string;
  kind: string;
  status: string;
  title: string;
  startAt: string | null;
  dueAt: string | null;
  timezone: string;
  metadata: Record<string, unknown>;
};

export async function saveTaskViewState(params: {
  userId: string;
  scope: TaskViewScope;
  title: string;
  items: PlannerItem[];
  metadata?: Record<string, unknown>;
  ttlMinutes?: number;
}): Promise<TaskViewState> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.ttlMinutes ?? 12 * 60) * 60 * 1000);
  const orderedItems = params.items.map((item, index): TaskViewItemSnapshot => ({
    displayIndex: index + 1,
    itemId: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    startAt: item.startAt?.toISOString() ?? null,
    dueAt: item.dueAt?.toISOString() ?? null,
    timezone: item.timezone,
    metadata: item.metadata ?? {},
  }));

  const [row] = await getDb()
    .insert(taskViewStates)
    .values({
      userId: params.userId,
      scope: params.scope,
      title: params.title,
      itemIds: params.items.map((item) => item.id),
      itemsSnapshot: orderedItems,
      metadata: params.metadata ?? {},
      expiresAt,
    })
    .returning();

  if (!row) throw new Error("Task view state was not saved");
  return row;
}

export async function getLatestTaskViewState(params: {
  userId: string;
  scope?: TaskViewScope | null;
  includeExpired?: boolean;
}): Promise<TaskViewState | null> {
  const conditions = [eq(taskViewStates.userId, params.userId)];
  if (params.scope) conditions.push(eq(taskViewStates.scope, params.scope));
  if (!params.includeExpired) conditions.push(gt(taskViewStates.expiresAt, new Date()));

  const [row] = await getDb()
    .select()
    .from(taskViewStates)
    .where(and(...conditions))
    .orderBy(desc(taskViewStates.createdAt))
    .limit(1);

  return row ?? null;
}

export async function listItemsByIds(userId: string, itemIds: string[]): Promise<PlannerItem[]> {
  if (!itemIds.length) return [];
  const rows = await getDb()
    .select()
    .from(plannerItems)
    .where(and(eq(plannerItems.userId, userId), inArray(plannerItems.id, itemIds)));

  const byId = new Map(rows.map((item) => [item.id, item]));
  return itemIds.map((id) => byId.get(id)).filter((item): item is PlannerItem => Boolean(item));
}
