import { and, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";

import { getDb } from "../client";
import { calendarSyncJobs, plannerItems, type PlannerItem } from "../schema";

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
        eq(plannerItems.status, "active"),
        visibleItemSql(),
        currentItemSql(),
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
      desc(plannerItems.priority),
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
        visibleItemSql(),
        currentItemSql(),
      ),
    )
    .orderBy(sql`${plannerItems.dueAt} asc nulls last`, desc(plannerItems.createdAt))
    .limit(limit);
}

export async function listManageableItems(userId: string, limit = 40): Promise<PlannerItem[]> {
  return getDb()
    .select()
    .from(plannerItems)
    .where(
      and(
        eq(plannerItems.userId, userId),
        inArray(plannerItems.kind, [
          "task",
          "event",
          "preparation_task",
          "recurring_task",
          "training",
          "tentative_event",
        ]),
        eq(plannerItems.status, "active"),
        visibleItemSql(),
        currentItemSql(),
      ),
    )
    .orderBy(
      sql`${plannerItems.dueAt} asc nulls last`,
      sql`${plannerItems.startAt} asc nulls last`,
      sql`nullif(${plannerItems.metadata}->>'orderIndex', '')::int asc nulls last`,
      desc(plannerItems.createdAt),
    )
    .limit(limit);
}

export async function listOverdueOpenItems(params: {
  userId: string;
  before: Date;
  limit?: number;
}): Promise<PlannerItem[]> {
  return getDb()
    .select()
    .from(plannerItems)
    .where(
      and(
        eq(plannerItems.userId, params.userId),
        eq(plannerItems.status, "active"),
        visibleItemSql(),
        currentItemSql(),
        or(
          and(isNotNull(plannerItems.dueAt), lte(plannerItems.dueAt, params.before)),
          and(isNotNull(plannerItems.startAt), lte(plannerItems.startAt, params.before)),
        ),
      ),
    )
    .orderBy(sql`coalesce(${plannerItems.dueAt}, ${plannerItems.startAt}) asc`)
    .limit(params.limit ?? 20);
}

export async function createManualPlannerItem(params: {
  userId: string;
  kind: string;
  title: string;
  timezone: string;
  startAt?: Date | null;
  endAt?: Date | null;
  dueAt?: Date | null;
  category?: string | null;
  visibility?: string | null;
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
      category: params.category,
      visibility: params.visibility ?? "active",
      metadata: params.metadata ?? {},
    })
    .returning();
  if (!item) throw new Error("Manual planner item was not created");
  return item;
}

export async function listVisibleActivePlanItems(userId: string, limit = 200): Promise<PlannerItem[]> {
  return getDb()
    .select()
    .from(plannerItems)
    .where(and(eq(plannerItems.userId, userId), eq(plannerItems.status, "active"), visibleItemSql()))
    .orderBy(
      sql`coalesce(${plannerItems.startAt}, ${plannerItems.dueAt}) asc nulls last`,
      desc(plannerItems.createdAt),
    )
    .limit(limit);
}

export async function listAllActiveItems(userId: string, limit = 500): Promise<PlannerItem[]> {
  return getDb()
    .select()
    .from(plannerItems)
    .where(and(eq(plannerItems.userId, userId), eq(plannerItems.status, "active")))
    .orderBy(desc(plannerItems.createdAt))
    .limit(limit);
}

export async function listDailyDigestItems(params: {
  userId: string;
  from: Date;
  to: Date;
  limit?: number;
}): Promise<PlannerItem[]> {
  return listVisibleItemsInWindow(params);
}

export async function listEveningReviewItems(params: {
  userId: string;
  from: Date;
  to: Date;
  limit?: number;
}): Promise<PlannerItem[]> {
  return listVisibleItemsInWindow(params);
}

export async function listYesterdayCarryCandidates(params: {
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
        eq(plannerItems.status, "active"),
        visibleItemSql(),
        currentItemSql(),
        ne(plannerItems.kind, "event"),
        ne(plannerItems.kind, "recurring_task"),
        itemInWindowSql(params.from, params.to),
      ),
    )
    .orderBy(sql`coalesce(${plannerItems.startAt}, ${plannerItems.dueAt}) asc`)
    .limit(params.limit ?? 10);
}

export async function listRecentRangeItems(params: {
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
        visibleItemSql(),
        itemInWindowSql(params.from, params.to),
      ),
    )
    .orderBy(sql`coalesce(${plannerItems.startAt}, ${plannerItems.dueAt}) asc`)
    .limit(params.limit ?? 120);
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

export async function cancelPlannerItem(userId: string, itemId: string): Promise<PlannerItem | null> {
  const [item] = await getDb()
    .update(plannerItems)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(plannerItems.userId, userId), eq(plannerItems.id, itemId)))
    .returning();
  return item ?? null;
}

export async function cancelPlannerItemWithMetadata(params: {
  userId: string;
  itemId: string;
  metadata: Record<string, unknown>;
}): Promise<PlannerItem | null> {
  const [item] = await getDb()
    .update(plannerItems)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
      archivedAt: new Date(),
      metadata: sql`${plannerItems.metadata} || ${JSON.stringify(params.metadata)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(plannerItems.userId, params.userId), eq(plannerItems.id, params.itemId)))
    .returning();
  return item ?? null;
}

export async function updatePlannerItemForReminderRepair(params: {
  userId: string;
  itemId: string;
  kind: string;
  title: string;
  timezone: string;
  startAt?: Date | null;
  endAt?: Date | null;
  dueAt?: Date | null;
  category?: string | null;
  visibility?: string | null;
  sourcePolicyId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const [item] = await getDb()
    .update(plannerItems)
    .set({
      kind: params.kind,
      title: params.title,
      timezone: params.timezone,
      startAt: params.startAt ?? null,
      endAt: params.endAt ?? null,
      dueAt: params.dueAt ?? null,
      category: params.category,
      visibility: params.visibility ?? "active",
      sourcePolicyId: params.sourcePolicyId,
      metadata: params.metadata
        ? sql`${plannerItems.metadata} || ${JSON.stringify(params.metadata)}::jsonb`
        : plannerItems.metadata,
      updatedAt: new Date(),
    })
    .where(and(eq(plannerItems.userId, params.userId), eq(plannerItems.id, params.itemId)))
    .returning();
  return item ?? null;
}

export async function listLegacyReminderLikeItems(userId: string, limit = 50) {
  return getDb()
    .select()
    .from(plannerItems)
    .where(
      and(
        eq(plannerItems.userId, userId),
        eq(plannerItems.status, "active"),
        sql`(
          ${plannerItems.title} ilike '%напоминан%'
          or ${plannerItems.title} ilike '%позвонить дрик%'
          or ${plannerItems.title} ilike '%винбокс%'
        )`,
        sql`not exists (
          select 1
          from "assistant"."reminder_policies" p
          where p.user_id = ${plannerItems.userId}
            and p.item_id = ${plannerItems.id}
            and p.status = 'active'
        )`,
      ),
    )
    .orderBy(desc(plannerItems.createdAt))
    .limit(limit);
}

export async function mergePlannerItemMetadata(params: {
  userId: string;
  itemId: string;
  metadata: Record<string, unknown>;
}): Promise<PlannerItem | null> {
  const [item] = await getDb()
    .update(plannerItems)
    .set({
      metadata: sql`${plannerItems.metadata} || ${JSON.stringify(params.metadata)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(plannerItems.userId, params.userId), eq(plannerItems.id, params.itemId)))
    .returning();
  return item ?? null;
}

export async function updatePlannerItemSchedule(params: {
  userId: string;
  itemId: string;
  startAt: Date | null;
  endAt: Date | null;
  dueAt: Date | null;
  metadata?: Record<string, unknown>;
}): Promise<PlannerItem | null> {
  const [item] = await getDb()
    .update(plannerItems)
    .set({
      startAt: params.startAt,
      endAt: params.endAt,
      dueAt: params.dueAt,
      metadata: params.metadata
        ? sql`${plannerItems.metadata} || ${JSON.stringify(params.metadata)}::jsonb`
        : plannerItems.metadata,
      updatedAt: new Date(),
    })
    .where(and(eq(plannerItems.userId, params.userId), eq(plannerItems.id, params.itemId)))
    .returning();
  return item ?? null;
}

export async function updatePlannerItemPriority(params: {
  userId: string;
  itemId: string;
  priority: number;
}) {
  const [item] = await getDb()
    .update(plannerItems)
    .set({ priority: Math.max(1, Math.min(5, params.priority)), updatedAt: new Date() })
    .where(and(eq(plannerItems.userId, params.userId), eq(plannerItems.id, params.itemId)))
    .returning();
  return item ?? null;
}

export async function setPlannerItemManualPriority(params: {
  userId: string;
  itemId: string;
  priority: number;
}) {
  const priority = Math.max(1, Math.min(5, params.priority));
  const [item] = await getDb()
    .update(plannerItems)
    .set({
      priority,
      metadata: sql`${plannerItems.metadata} || ${JSON.stringify({
        basePriority: priority,
        importanceMode: "manual",
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(plannerItems.userId, params.userId), eq(plannerItems.id, params.itemId)))
    .returning();
  return item ?? null;
}

export async function listCampaignItems(userId: string, campaignGroup: string, limit = 100) {
  return getDb()
    .select()
    .from(plannerItems)
    .where(
      and(
        eq(plannerItems.userId, userId),
        sql`${plannerItems.metadata}->>'campaignGroup' = ${campaignGroup}`,
      ),
    )
    .orderBy(sql`nullif(${plannerItems.metadata}->>'campaignSequence', '')::int asc nulls last`)
    .limit(limit);
}

export async function cancelCalendarSyncJobsForItem(plannerItemId: string) {
  await getDb()
    .update(calendarSyncJobs)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(calendarSyncJobs.plannerItemId, plannerItemId));
}

export async function restorePlannerItemStatus(params: {
  userId: string;
  itemId: string;
  status: string;
  completedAt?: Date | null;
}): Promise<PlannerItem | null> {
  const [item] = await getDb()
    .update(plannerItems)
    .set({
      status: params.status,
      completedAt: params.completedAt ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(plannerItems.userId, params.userId), eq(plannerItems.id, params.itemId)))
    .returning();
  return item ?? null;
}

async function listVisibleItemsInWindow(params: {
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
        eq(plannerItems.status, "active"),
        visibleItemSql(),
        currentItemSql(),
        itemInWindowSql(params.from, params.to),
      ),
    )
    .orderBy(sql`coalesce(${plannerItems.startAt}, ${plannerItems.dueAt}) asc`)
    .limit(params.limit ?? 80);
}

function visibleItemSql() {
  return sql<boolean>`
    coalesce(${plannerItems.metadata}->>'isTest', 'false') <> 'true'
    and coalesce(${plannerItems.metadata}->>'debug', 'false') <> 'true'
    and coalesce(${plannerItems.metadata}->>'garbage', 'false') <> 'true'
    and coalesce(${plannerItems.metadata}->>'command', '') <> 'remindertest'
    and coalesce(${plannerItems.metadata}->>'source', '') <> 'remindertest'
    and coalesce(${plannerItems.visibility}, 'active') <> 'hidden'
  `;
}

function currentItemSql() {
  return sql<boolean>`coalesce(${plannerItems.visibility}, 'active') <> 'history'`;
}

function itemInWindowSql(from: Date, to: Date) {
  return or(
    and(isNotNull(plannerItems.startAt), gte(plannerItems.startAt, from), lte(plannerItems.startAt, to)),
    and(isNotNull(plannerItems.dueAt), gte(plannerItems.dueAt, from), lte(plannerItems.dueAt, to)),
  );
}
