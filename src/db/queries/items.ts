import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";

import { getDb } from "../client";
import { plannerItems, type PlannerItem } from "../schema";

export async function listItemsBetween(params: {
  userId: string;
  from: Date;
  to: Date;
  limit?: number;
}): Promise<PlannerItem[]> {
  return getDb()
    .select()
    .from(plannerItems)
    .where(
      and(
        eq(plannerItems.userId, params.userId),
        ne(plannerItems.status, "cancelled"),
        or(
          and(
            isNotNull(plannerItems.startAt),
            gte(plannerItems.startAt, params.from),
            lte(plannerItems.startAt, params.to),
          ),
          and(
            isNotNull(plannerItems.dueAt),
            gte(plannerItems.dueAt, params.from),
            lte(plannerItems.dueAt, params.to),
          ),
        ),
      ),
    )
    .orderBy(
      sql`coalesce(${plannerItems.startAt}, ${plannerItems.dueAt}) asc`,
      asc(plannerItems.priority),
    )
    .limit(params.limit ?? 50);
}

export async function listOpenTasks(userId: string, limit = 30): Promise<PlannerItem[]> {
  return getDb()
    .select()
    .from(plannerItems)
    .where(
      and(
        eq(plannerItems.userId, userId),
        inArray(plannerItems.kind, ["task", "preparation_task", "recurring_task"]),
        eq(plannerItems.status, "active"),
      ),
    )
    .orderBy(sql`${plannerItems.dueAt} asc nulls last`, desc(plannerItems.createdAt))
    .limit(limit);
}

export async function createManualPlannerItem(params: {
  userId: string;
  kind: string;
  title: string;
  timezone: string;
  startAt?: Date | null;
  endAt?: Date | null;
  dueAt?: Date | null;
  metadata?: Record<string, unknown>;
}) {
  const [item] = await getDb()
    .insert(plannerItems)
    .values({
      userId: params.userId,
      kind: params.kind,
      title: params.title,
      timezone: params.timezone,
      startAt: params.startAt,
      endAt: params.endAt,
      dueAt: params.dueAt,
      metadata: params.metadata ?? {},
    })
    .returning();
  if (!item) throw new Error("Manual planner item was not created");
  return item;
}

export async function getPlannerItemById(
  userId: string,
  itemId: string,
): Promise<PlannerItem | null> {
  const [item] = await getDb()
    .select()
    .from(plannerItems)
    .where(and(eq(plannerItems.userId, userId), eq(plannerItems.id, itemId)))
    .limit(1);
  return item ?? null;
}

export async function getPlannerItemByAnyId(itemId: string): Promise<PlannerItem | null> {
  const [item] = await getDb()
    .select()
    .from(plannerItems)
    .where(eq(plannerItems.id, itemId))
    .limit(1);
  return item ?? null;
}

export async function markPlannerItemCompleted(
  userId: string,
  itemId: string,
): Promise<PlannerItem | null> {
  const [item] = await getDb()
    .update(plannerItems)
    .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(plannerItems.userId, userId), eq(plannerItems.id, itemId)))
    .returning();
  return item ?? null;
}
