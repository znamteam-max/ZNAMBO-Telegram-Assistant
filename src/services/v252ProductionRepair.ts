import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { getDb } from "@/db/client";
import {
  auditLog,
  plannerItems,
  reminderPolicies,
  reminders,
  telegramMessageRegistry,
} from "@/db/schema";
import { applyV251ProductionRepair, previewV251ProductionRepair } from "./v251ProductionRepair";

export async function previewV252ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const overdueBefore = DateTime.fromJSDate(now, { zone: "utc" }).minus({ days: 30 }).toJSDate();
  const [v251, orthodontistItems, drikOrphans, oldOverdueItems, staleBotCards] = await Promise.all([
    previewV251ProductionRepair(params.userId),
    getDb()
      .select()
      .from(plannerItems)
      .where(
        and(
          eq(plannerItems.userId, params.userId),
          eq(plannerItems.status, "active"),
          sql`${plannerItems.title} ilike '%ортодонт%'`,
        ),
      ),
    getDb()
      .select()
      .from(plannerItems)
      .where(
        and(
          eq(plannerItems.userId, params.userId),
          eq(plannerItems.status, "active"),
          sql`${plannerItems.title} ilike '%дрик%'`,
          sql`not exists (
            select 1 from "assistant"."reminder_policies" p
            where p.user_id = ${plannerItems.userId}
              and p.item_id = ${plannerItems.id}
              and p.status = 'active'
          )`,
        ),
      ),
    getDb()
      .select()
      .from(plannerItems)
      .where(
        and(
          eq(plannerItems.userId, params.userId),
          eq(plannerItems.status, "active"),
          or(lt(plannerItems.startAt, overdueBefore), lt(plannerItems.dueAt, overdueBefore)),
        ),
      ),
    getDb()
      .select()
      .from(telegramMessageRegistry)
      .where(
        and(
          eq(telegramMessageRegistry.userId, params.userId),
          eq(telegramMessageRegistry.status, "active"),
          inArray(telegramMessageRegistry.purpose, [
            "reminder",
            "followup",
            "confirmation",
            "transient_status",
            "item_menu",
            "policy_editor",
          ]),
        ),
      ),
  ]);
  return { v251, orthodontistItems, drikOrphans, oldOverdueItems, staleBotCards };
}

export async function applyV252ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const preview = await previewV252ProductionRepair(params);
  await applyV251ProductionRepair(params.userId);
  const orthodontistStart = DateTime.fromObject(
    { year: 2026, month: 6, day: 16, hour: 10, minute: 20 },
    { zone: params.timezone },
  )
    .toUTC()
    .toJSDate();

  await getDb().transaction(async (tx) => {
    for (const item of preview.orthodontistItems) {
      await tx
        .update(plannerItems)
        .set({
          kind: "event",
          category: "health",
          startAt: orthodontistStart,
          dueAt: null,
          priority: 4,
          metadata: sql`${plannerItems.metadata} || ${JSON.stringify({
            repairVersion: "2.5.2",
            importanceMode: "auto",
            basePriority: 4,
            familyRelated: true,
            reminderSuggestion: "offer_before_event",
          })}::jsonb`,
          updatedAt: now,
        })
        .where(and(eq(plannerItems.userId, params.userId), eq(plannerItems.id, item.id)));
    }

    for (const item of preview.drikOrphans) {
      await tx
        .update(plannerItems)
        .set({
          category: "people",
          metadata: sql`${plannerItems.metadata} || ${JSON.stringify({
            repairVersion: "2.5.2",
            legacyOrphan: true,
            importanceMode: item.metadata?.importanceMode ?? "ask_later",
          })}::jsonb`,
          updatedAt: now,
        })
        .where(and(eq(plannerItems.userId, params.userId), eq(plannerItems.id, item.id)));
    }

    const oldIds = preview.oldOverdueItems.map((item) => item.id);
    if (oldIds.length) {
      await tx
        .update(plannerItems)
        .set({
          status: "archived",
          archivedAt: now,
          metadata: sql`${plannerItems.metadata} || '{"repairVersion":"2.5.2","oldOverdueArchived":true}'::jsonb`,
          updatedAt: now,
        })
        .where(and(eq(plannerItems.userId, params.userId), inArray(plannerItems.id, oldIds)));
      await tx
        .update(reminders)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            eq(reminders.userId, params.userId),
            inArray(reminders.plannerItemId, oldIds),
            inArray(reminders.status, ["pending", "claimed"]),
          ),
        );
      await tx
        .update(reminderPolicies)
        .set({ status: "expired", nextFireAt: null, updatedAt: now })
        .where(
          and(
            eq(reminderPolicies.userId, params.userId),
            inArray(reminderPolicies.itemId, oldIds),
            eq(reminderPolicies.status, "active"),
          ),
        );
    }

    if (preview.staleBotCards.length) {
      await tx
        .update(telegramMessageRegistry)
        .set({ status: "stale", updatedAt: now })
        .where(inArray(telegramMessageRegistry.id, preview.staleBotCards.map((entry) => entry.id)));
    }

    await tx.insert(auditLog).values({
      userId: params.userId,
      action: "assistant.production_repair_v252",
      entityType: "production_repair",
      details: {
        repairVersion: "2.5.2",
        undo: {
          orthodontistItems: preview.orthodontistItems,
          drikOrphans: preview.drikOrphans,
          oldOverdueItems: preview.oldOverdueItems,
          staleBotCards: preview.staleBotCards,
        },
      },
    });
  });
  return preview;
}
