import { and, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { getDb } from "@/db/client";
import {
  auditLog,
  plannerItems,
  reminderPolicies,
  reminders,
  telegramMessageRegistry,
  type PlannerItem,
} from "@/db/schema";
import { applyV251ProductionRepair, previewV251ProductionRepair } from "./v251ProductionRepair";

const REPAIR_VERSION = "2.5.3";

export async function previewV252ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const overdueBefore = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const desiredOrthodontistStart = orthodontistStart(params.timezone);
  const [v251, orthodontistAll, drikAll, oldOverdueItems, staleBotCards] = await Promise.all([
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
        ),
      ),
    getDb()
      .select()
      .from(plannerItems)
      .where(
        and(
          eq(plannerItems.userId, params.userId),
          eq(plannerItems.status, "active"),
          ne(plannerItems.kind, "event"),
          ne(plannerItems.kind, "recurring_task"),
          sql`coalesce(${plannerItems.visibility}, 'active') <> 'history'`,
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

  const orthodontistDuplicateIds = duplicateIdsByNormalizedTitle(orthodontistAll);
  const orthodontistItems = orthodontistAll.filter(
    (item) =>
      orthodontistDuplicateIds.includes(item.id) ||
      item.startAt?.getTime() !== desiredOrthodontistStart.getTime() ||
      item.kind !== "event" ||
      item.category !== "health" ||
      item.metadata?.repairVersion !== REPAIR_VERSION,
  );
  const drikDuplicateIds = duplicateDrikItemIds(drikAll, now);
  const drikReminderLikeIds = drikAll
    .filter((item) => /напоминан/i.test(item.title))
    .map((item) => item.id);
  const drikOrphans = drikAll.filter(
    (item) =>
      drikDuplicateIds.includes(item.id) ||
      drikReminderLikeIds.includes(item.id) ||
      isOldDrikItem(item, overdueBefore),
  );

  return {
    v251,
    orthodontistItems,
    orthodontistDuplicateIds,
    drikOrphans,
    drikDuplicateIds,
    drikReminderLikeIds,
    oldOverdueItems,
    staleBotCards,
  };
}

export async function applyV252ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const preview = await previewV252ProductionRepair(params);
  await applyV251ProductionRepair(params.userId);
  const desiredStart = orthodontistStart(params.timezone);
  const archiveIds = [
    ...new Set([
      ...preview.orthodontistDuplicateIds,
      ...preview.drikDuplicateIds,
      ...preview.drikReminderLikeIds,
    ]),
  ];
  const historyIds = preview.oldOverdueItems
    .map((item) => item.id)
    .filter((id) => !archiveIds.includes(id));
  const canonicalOrthodontist = preview.orthodontistItems.find(
    (item) => !preview.orthodontistDuplicateIds.includes(item.id),
  );

  await getDb().transaction(async (tx) => {
    if (canonicalOrthodontist) {
      await tx
        .update(plannerItems)
        .set({
          kind: "event",
          category: "health",
          startAt: desiredStart,
          dueAt: null,
          priority: 4,
          visibility: "active",
          metadata: sql`${plannerItems.metadata} || ${JSON.stringify({
            repairVersion: REPAIR_VERSION,
            importanceMode: "auto",
            basePriority: 4,
            familyRelated: true,
            reminderSuggestion: "offer_before_event",
          })}::jsonb`,
          updatedAt: now,
        })
        .where(
          and(
            eq(plannerItems.userId, params.userId),
            eq(plannerItems.id, canonicalOrthodontist.id),
          ),
        );
    }

    if (archiveIds.length) {
      await tx
        .update(plannerItems)
        .set({
          status: "archived",
          visibility: "history",
          archivedAt: now,
          metadata: sql`${plannerItems.metadata} || ${JSON.stringify({
            repairVersion: REPAIR_VERSION,
            productionRepairArchived: true,
          })}::jsonb`,
          updatedAt: now,
        })
        .where(and(eq(plannerItems.userId, params.userId), inArray(plannerItems.id, archiveIds)));
    }

    if (historyIds.length) {
      await tx
        .update(plannerItems)
        .set({
          visibility: "history",
          metadata: sql`${plannerItems.metadata} || ${JSON.stringify({
            repairVersion: REPAIR_VERSION,
            dailyHistoryState: "unresolved",
            missed: true,
            carriedOverCandidate: true,
          })}::jsonb`,
          updatedAt: now,
        })
        .where(and(eq(plannerItems.userId, params.userId), inArray(plannerItems.id, historyIds)));
    }

    const stoppedIds = [...new Set([...archiveIds, ...historyIds])];
    if (stoppedIds.length) {
      await tx
        .update(reminders)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            eq(reminders.userId, params.userId),
            inArray(reminders.plannerItemId, stoppedIds),
            inArray(reminders.status, ["pending", "claimed"]),
          ),
        );
      await tx
        .update(reminderPolicies)
        .set({ status: "expired", nextFireAt: null, updatedAt: now })
        .where(
          and(
            eq(reminderPolicies.userId, params.userId),
            inArray(reminderPolicies.itemId, stoppedIds),
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
      action: "assistant.production_repair_v253",
      entityType: "production_repair",
      details: {
        repairVersion: REPAIR_VERSION,
        canonicalOrthodontistId: canonicalOrthodontist?.id ?? null,
        archivedItemIds: archiveIds,
        movedToHistoryItemIds: historyIds,
        undo: {
          orthodontistItems: preview.orthodontistItems,
          drikOrphans: preview.drikOrphans,
          oldOverdueItems: preview.oldOverdueItems,
          staleBotCards: preview.staleBotCards,
        },
      },
    });
  });
  return {
    ...preview,
    canonicalOrthodontistId: canonicalOrthodontist?.id ?? null,
    archivedItemIds: archiveIds,
    movedToHistoryItemIds: historyIds,
  };
}

export function duplicateDrikItemIds(items: PlannerItem[], now = new Date()) {
  const byIntent = new Map<string, PlannerItem[]>();
  for (const item of items) {
    const key = normalizeDrikIntent(item.title);
    byIntent.set(key, [...(byIntent.get(key) ?? []), item]);
  }
  const duplicateIds: string[] = [];
  for (const group of byIntent.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => canonicalRank(a, now) - canonicalRank(b, now));
    duplicateIds.push(...sorted.slice(1).map((item) => item.id));
  }
  return duplicateIds;
}

function duplicateIdsByNormalizedTitle(items: PlannerItem[]) {
  if (items.length < 2) return [];
  const sorted = [...items].sort((a, b) => {
    const aCorrect = a.startAt?.getTime() === orthodontistStart(a.timezone).getTime() ? 0 : 1;
    const bCorrect = b.startAt?.getTime() === orthodontistStart(b.timezone).getTime() ? 0 : 1;
    return aCorrect - bCorrect || a.createdAt.getTime() - b.createdAt.getTime();
  });
  return sorted.slice(1).map((item) => item.id);
}

function normalizeDrikIntent(title: string) {
  return title
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/напоминан\w*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalRank(item: PlannerItem, now: Date) {
  const anchor = item.startAt ?? item.dueAt;
  const futurePenalty = anchor && anchor >= now ? 0 : 10;
  const policyPenalty = item.sourcePolicyId ? 0 : 2;
  return futurePenalty + policyPenalty - item.updatedAt.getTime() / 1e15;
}

function isOldDrikItem(item: PlannerItem, overdueBefore: Date) {
  const anchor = item.startAt ?? item.dueAt;
  return Boolean(anchor && anchor < overdueBefore && !item.sourcePolicyId);
}

function orthodontistStart(timezone: string) {
  return DateTime.fromObject(
    { year: 2026, month: 6, day: 16, hour: 10, minute: 20 },
    { zone: timezone },
  )
    .toUTC()
    .toJSDate();
}
