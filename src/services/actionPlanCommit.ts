import { and, eq, gt } from "drizzle-orm";
import { DateTime } from "luxon";

import { actionPlanSchema, type ActionPlan, type ActionPlanItem } from "@/ai/schemas";
import { getDb } from "@/db/client";
import { actionPlanItems, actionPlans, auditLog, plannerItems, reminders } from "@/db/schema";
import { localIsoToUtcDate } from "@/domain/dateTime";
import type { MaterializedItem, MaterializedReminder } from "@/domain/types";
import { UserFacingError } from "@/lib/errors";

import { storePlanMemoryFacts } from "./memory";

export type StoredActionPlan = typeof actionPlans.$inferSelect;

export function shouldAutoCommitPlan(
  plan: ActionPlan,
  smartCommitMode: string | null | undefined,
): boolean {
  if (plan.intent !== "plan" || !plan.actions.length) return false;
  if (smartCommitMode === "confirm_all") return false;
  if (smartCommitMode === "auto_all_with_undo") return !plan.actions.some((item) => item.risk === "high");
  return (
    !plan.requiresConfirmation &&
    plan.confidence >= 0.75 &&
    plan.actions.every(
      (item) => !item.requiresConfirmation && item.risk !== "high" && item.confidence >= 0.72,
    )
  );
}

export async function createStoredActionPlan(params: {
  userId: string;
  sourceMessageId?: string | null;
  plan: ActionPlan;
  idempotencyKey: string;
  commitMode: string;
  ttlMinutes?: number;
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.ttlMinutes ?? 60) * 60 * 1000);
  const [inserted] = await getDb()
    .insert(actionPlans)
    .values({
      userId: params.userId,
      sourceMessageId: params.sourceMessageId,
      status: "pending",
      summary: params.plan.summary,
      commitMode: params.commitMode,
      confidencePercent: Math.round(params.plan.confidence * 100),
      payload: params.plan,
      idempotencyKey: params.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing({ target: actionPlans.idempotencyKey })
    .returning();

  const planRecord = inserted ?? (await findActionPlanByIdempotencyKey(params.idempotencyKey));
  if (!planRecord) throw new Error("Action plan was not stored");

  if (inserted && params.plan.actions.length) {
    await getDb()
      .insert(actionPlanItems)
      .values(
        params.plan.actions.map((item, index) => ({
          actionPlanId: planRecord.id,
          userId: params.userId,
          sequence: index,
          actionType: item.actionType,
          payload: item,
        })),
      )
      .onConflictDoNothing();
  }

  return planRecord;
}

export async function commitStoredActionPlan(params: {
  actionPlanId: string;
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  return getDb().transaction(async (tx) => {
    const [planRecord] = await tx
      .update(actionPlans)
      .set({
        status: "committed",
        confirmedAt: now,
        committedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(actionPlans.id, params.actionPlanId),
          eq(actionPlans.userId, params.userId),
          eq(actionPlans.status, "pending"),
          gt(actionPlans.expiresAt, now),
        ),
      )
      .returning();

    if (!planRecord) {
      const [existing] = await tx
        .select()
        .from(actionPlans)
        .where(and(eq(actionPlans.id, params.actionPlanId), eq(actionPlans.userId, params.userId)))
        .limit(1);
      if (!existing) return { status: "not_found" as const };
      if (existing.status === "cancelled") return { status: "cancelled" as const };
      if (existing.status === "committed") return { status: "already_committed" as const };
      return { status: "expired" as const };
    }

    const plan = actionPlanSchema.parse(planRecord.payload);
    const createdItems = [];
    const createdReminders: MaterializedReminder[] = [];

    for (const [index, action] of plan.actions.entries()) {
      const materialized = materializeAction({
        action,
        timezone: params.timezone,
        now,
        actionPlanId: planRecord.id,
        sequence: index,
      });

      const [item] = await tx
        .insert(plannerItems)
        .values({
          userId: params.userId,
          kind: materialized.item.kind,
          title: materialized.item.title,
          description: materialized.item.description,
          location: materialized.item.location,
          timezone: materialized.item.timezone,
          startAt: materialized.item.startAt,
          endAt: materialized.item.endAt,
          dueAt: materialized.item.dueAt,
          priority: materialized.item.priority,
          metadata: materialized.item.metadata,
        })
        .returning();

      if (!item) throw new UserFacingError("Не получилось создать запись плана.");
      createdItems.push(item);

      await tx
        .update(actionPlanItems)
        .set({ status: "committed", committedItemId: item.id, updatedAt: now })
        .where(
          and(eq(actionPlanItems.actionPlanId, planRecord.id), eq(actionPlanItems.sequence, index)),
        );

      if (materialized.reminders.length) {
        createdReminders.push(...materialized.reminders);
        await tx
          .insert(reminders)
          .values(
            materialized.reminders.map((reminder) => ({
              userId: params.userId,
              plannerItemId: item.id,
              type: reminder.type,
              idempotencyKey: `${planRecord.id}:${index}:${reminder.type}:${reminder.scheduledAt.toISOString()}`,
              scheduledAt: reminder.scheduledAt,
              repeatUntilAck: reminder.repeatUntilAck ?? false,
              recurrenceKey: reminder.recurrenceKey,
              payload: reminder.payload,
            })),
          )
          .onConflictDoNothing();
      }

      await tx.insert(auditLog).values({
        userId: params.userId,
        action: "action_plan.item_created",
        entityType: "planner_item",
        entityId: item.id,
        details: { actionPlanId: planRecord.id, sequence: index, kind: item.kind },
      });
    }

    return {
      status: "committed" as const,
      plan: planRecord,
      items: createdItems,
      reminders: createdReminders,
      parsedPlan: plan,
    };
  }).then(async (result) => {
    if (result.status === "committed") {
      await storePlanMemoryFacts({
        userId: params.userId,
        sourceMessageId: result.plan.sourceMessageId,
        plan: result.parsedPlan,
      });
    }
    return result;
  });
}

export async function cancelStoredActionPlan(params: {
  actionPlanId: string;
  userId: string;
}) {
  const [cancelled] = await getDb()
    .update(actionPlans)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(actionPlans.id, params.actionPlanId),
        eq(actionPlans.userId, params.userId),
        eq(actionPlans.status, "pending"),
      ),
    )
    .returning();
  return cancelled ?? null;
}

async function findActionPlanByIdempotencyKey(idempotencyKey: string) {
  const [existing] = await getDb()
    .select()
    .from(actionPlans)
    .where(eq(actionPlans.idempotencyKey, idempotencyKey))
    .limit(1);
  return existing ?? null;
}

function materializeAction(params: {
  action: ActionPlanItem;
  timezone: string;
  now: Date;
  actionPlanId: string;
  sequence: number;
}): { item: MaterializedItem; reminders: MaterializedReminder[] } {
  const timezone = params.action.timezone || params.timezone;
  const startAt = params.action.startAtLocal
    ? localIsoToUtcDate(params.action.startAtLocal, timezone)
    : null;
  const dueAt = params.action.dueAtLocal ? localIsoToUtcDate(params.action.dueAtLocal, timezone) : null;
  const endAt = buildEndAt(params.action, timezone, startAt);
  const item: MaterializedItem = {
    kind: params.action.kind,
    title: params.action.title.trim(),
    description: params.action.description,
    location: params.action.location,
    timezone,
    startAt,
    endAt,
    dueAt,
    priority: params.action.priority,
    metadata: {
      actionPlanId: params.actionPlanId,
      actionPlanSequence: params.sequence,
      actionType: params.action.actionType,
      confidence: params.action.confidence,
      risk: params.action.risk,
      tentative: params.action.tentative,
      recurrence: params.action.recurrence,
    },
  };

  const reminders: MaterializedReminder[] = [];
  for (const reminder of params.action.reminders) {
    if (!reminder.scheduledAtLocal) continue;
    const scheduledAt = localIsoToUtcDate(reminder.scheduledAtLocal, timezone);
    if (scheduledAt.getTime() <= params.now.getTime()) continue;
    reminders.push({
      type: reminder.type,
      scheduledAt,
      repeatUntilAck: reminder.repeatUntilAck || params.action.recurrence?.repeatUntilAck || false,
      recurrenceKey: params.action.recurrence
        ? `${params.action.recurrence.frequency}:${params.action.recurrence.daysOfWeek.join(",")}:${params.action.recurrence.timeLocal}`
        : null,
      payload: {
        ...reminder.payload,
        title: params.action.title,
        kind: params.action.kind,
        actionType: params.action.actionType,
        recurrence: params.action.recurrence,
      },
    });
  }

  return { item, reminders };
}

function buildEndAt(action: ActionPlanItem, timezone: string, startAt: Date | null) {
  if (action.endAtLocal) return localIsoToUtcDate(action.endAtLocal, timezone);
  if (!startAt || !action.durationMinutes) return null;
  return DateTime.fromJSDate(startAt, { zone: "utc" }).plus({ minutes: action.durationMinutes }).toJSDate();
}
