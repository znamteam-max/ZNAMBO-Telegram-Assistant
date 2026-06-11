import { and, eq, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { getDb } from "@/db/client";
import {
  auditLog,
  plannerItems,
  reminderPolicies,
  reminders,
  telegramMessageRegistry,
  type ReminderPolicy,
} from "@/db/schema";

export async function previewV251ProductionRepair(userId: string) {
  const [malformedItems, malformedPolicies, centralItems, centralPolicies, staleBotCards] =
    await Promise.all([
      getDb()
        .select({ id: plannerItems.id, title: plannerItems.title })
        .from(plannerItems)
        .where(
          and(
            eq(plannerItems.userId, userId),
            eq(plannerItems.status, "active"),
            sql`${plannerItems.title} ilike '%сделать его .%'`,
          ),
        ),
      getDb()
        .select()
        .from(reminderPolicies)
        .where(
          and(
            eq(reminderPolicies.userId, userId),
            eq(reminderPolicies.status, "active"),
            sql`${reminderPolicies.title} ilike '%сделать его .%'`,
          ),
        ),
      getDb()
        .select()
        .from(plannerItems)
        .where(
          and(
            eq(plannerItems.userId, userId),
            eq(plannerItems.status, "active"),
            sql`${plannerItems.title} ilike '%Central Park%'`,
          ),
        ),
      getDb()
        .select()
        .from(reminderPolicies)
        .where(
          and(
            eq(reminderPolicies.userId, userId),
            eq(reminderPolicies.status, "active"),
            sql`${reminderPolicies.title} ilike '%Central Park%'`,
          ),
        ),
      getDb()
        .select({ id: telegramMessageRegistry.id })
        .from(telegramMessageRegistry)
        .where(
          and(
            eq(telegramMessageRegistry.userId, userId),
            eq(telegramMessageRegistry.status, "active"),
            inArray(telegramMessageRegistry.purpose, [
              "reminder",
              "followup",
              "confirmation",
              "transient_status",
            ]),
          ),
        ),
    ]);
  return {
    malformedItems,
    malformedPolicies,
    centralItems,
    centralPolicies,
    duplicateCentralPolicyIds: findDuplicateCentralPolicyIds(centralPolicies),
    staleBotCards,
  };
}

export async function applyV251ProductionRepair(userId: string) {
  const preview = await previewV251ProductionRepair(userId);
  const now = new Date();
  await getDb().transaction(async (tx) => {
    const malformedItemIds = preview.malformedItems.map((item) => item.id);
    if (malformedItemIds.length) {
      await tx
        .update(plannerItems)
        .set({
          status: "cancelled",
          cancelledAt: now,
          archivedAt: now,
          metadata: sql`${plannerItems.metadata} || '{"repairVersion":"2.5.1","garbage":true}'::jsonb`,
          updatedAt: now,
        })
        .where(and(eq(plannerItems.userId, userId), inArray(plannerItems.id, malformedItemIds)));
      await tx
        .update(reminders)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            eq(reminders.userId, userId),
            inArray(reminders.plannerItemId, malformedItemIds),
            inArray(reminders.status, ["pending", "claimed"]),
          ),
        );
    }

    const invalidPolicyIds = [
      ...new Set([
        ...preview.malformedPolicies.map((policy) => policy.id),
        ...preview.duplicateCentralPolicyIds,
      ]),
    ];
    if (invalidPolicyIds.length) {
      await tx
        .update(reminderPolicies)
        .set({
          status: "expired",
          nextFireAt: null,
          metadata: sql`${reminderPolicies.metadata} || '{"repairVersion":"2.5.1","duplicateOrMalformed":true}'::jsonb`,
          updatedAt: now,
        })
        .where(
          and(eq(reminderPolicies.userId, userId), inArray(reminderPolicies.id, invalidPolicyIds)),
        );
      await tx
        .update(reminders)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            eq(reminders.userId, userId),
            inArray(reminders.policyId, invalidPolicyIds),
            inArray(reminders.status, ["pending", "claimed"]),
          ),
        );
    }

    const sortedCentralItems = [...preview.centralItems].sort(
      (a, b) =>
        (a.startAt ?? a.dueAt ?? a.createdAt).getTime() -
        (b.startAt ?? b.dueAt ?? b.createdAt).getTime(),
    );
    const itemSequence = new Map(
      sortedCentralItems.map((item, index) => [item.id, index === 0 ? 1 : 2]),
    );
    const uniqueCentralPolicies = preview.centralPolicies.filter(
      (policy) => !preview.duplicateCentralPolicyIds.includes(policy.id),
    );
    const firstEnd =
      sortedCentralItems[0]?.endAt ??
      sortedCentralItems[0]?.startAt ??
      [...uniqueCentralPolicies].sort(
        (a, b) => (a.endsAt?.getTime() ?? Infinity) - (b.endsAt?.getTime() ?? Infinity),
      )[0]?.endsAt ??
      null;

    for (const item of sortedCentralItems) {
      const sequence = itemSequence.get(item.id) ?? 1;
      const waiting = sequence === 2 && (!firstEnd || now < firstEnd);
      await tx
        .update(plannerItems)
        .set({
          priority: 5,
          metadata: sql`${plannerItems.metadata} || ${JSON.stringify({
            repairVersion: "2.5.1",
            campaignGroup: "central_park",
            campaignSequence: sequence,
            campaignState: waiting ? "waiting" : "active",
          })}::jsonb`,
          updatedAt: now,
        })
        .where(and(eq(plannerItems.userId, userId), eq(plannerItems.id, item.id)));
    }

    for (const policy of uniqueCentralPolicies) {
      const sequence =
        (policy.itemId ? itemSequence.get(policy.itemId) : undefined) ??
        (firstEnd && policy.endsAt && policy.endsAt > firstEnd ? 2 : 1);
      const waiting = sequence === 2 && (!firstEnd || now < firstEnd);
      const nextFireAt =
        waiting && firstEnd && policy.nextFireAt && policy.nextFireAt < firstEnd
          ? nextDailyPolicyTime(policy.recurrenceRule, firstEnd, policy.timezone)
          : policy.nextFireAt;
      await tx
        .update(reminderPolicies)
        .set({
          startsAt: waiting && firstEnd ? firstEnd : policy.startsAt,
          nextFireAt,
          metadata: sql`${reminderPolicies.metadata} || ${JSON.stringify({
            repairVersion: "2.5.1",
            campaignGroup: "central_park",
            campaignSequence: sequence,
            campaignState: waiting ? "waiting" : "active",
            basePriority: 5,
          })}::jsonb`,
          updatedAt: now,
        })
        .where(and(eq(reminderPolicies.userId, userId), eq(reminderPolicies.id, policy.id)));
      if (waiting && firstEnd) {
        await tx
          .update(reminders)
          .set({ status: "cancelled", updatedAt: now })
          .where(
            and(
              eq(reminders.policyId, policy.id),
              inArray(reminders.status, ["pending", "claimed"]),
              sql`${reminders.scheduledAt} < ${firstEnd.toISOString()}::timestamptz`,
            ),
          );
      }
    }

    if (preview.staleBotCards.length) {
      await tx
        .update(telegramMessageRegistry)
        .set({ status: "stale", updatedAt: now })
        .where(
          inArray(
            telegramMessageRegistry.id,
            preview.staleBotCards.map((entry) => entry.id),
          ),
        );
    }
    await tx.insert(auditLog).values({
      userId,
      action: "assistant.production_repair_v251",
      entityType: "production_repair",
      details: {
        malformedItemIds,
        malformedPolicyIds: preview.malformedPolicies.map((policy) => policy.id),
        centralItemIds: preview.centralItems.map((item) => item.id),
        centralPolicyIds: preview.centralPolicies.map((policy) => policy.id),
        duplicateCentralPolicyIds: preview.duplicateCentralPolicyIds,
        staleBotCardIds: preview.staleBotCards.map((entry) => entry.id),
      },
    });
  });
  return preview;
}

export function findDuplicateCentralPolicyIds(policies: ReminderPolicy[]) {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const policy of [...policies].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const eventKey =
      policy.itemId ??
      policy.endsAt?.toISOString().slice(0, 10) ??
      policy.startsAt?.toISOString().slice(0, 10) ??
      "unattached";
    const scheduleKey = policy.recurrenceRule ?? policy.title.toLocaleLowerCase("ru");
    const key = `${eventKey}|${policy.policyType}|${scheduleKey}`;
    if (seen.has(key)) duplicates.push(policy.id);
    else seen.add(key);
  }
  return duplicates;
}

function nextDailyPolicyTime(rule: string | null, after: Date, timezone: string) {
  const match = rule?.match(/daily_at_(\d{2}):(\d{2})/);
  const local = DateTime.fromJSDate(after, { zone: "utc" }).setZone(timezone);
  let next = local.startOf("day").set({
    hour: Number(match?.[1] ?? 10),
    minute: Number(match?.[2] ?? 0),
  });
  if (next <= local) next = next.plus({ days: 1 });
  return next.toUTC().toJSDate();
}
