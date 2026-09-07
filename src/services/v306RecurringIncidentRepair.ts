import { DateTime } from "luxon";

import {
  cancelPlannerItemWithMetadata,
  getPlannerItemByAnyId,
  restoreCompletedPlannerItem,
  updatePlannerItemDetails,
} from "@/db/queries/items";
import {
  createReminderPolicyIfMissing,
  listReminderPoliciesForItem,
  stopPoliciesForItem,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import {
  cancelItemReminders,
  cancelPendingRemindersForPolicy,
} from "@/db/queries/reminders";
import { writeAudit } from "@/db/queries/audit";
import { nextRecurringOccurrence } from "@/domain/recurringPolicySemantics";
import {
  buildRecurringScheduleRule,
  resolveRecurringScheduleTiming,
} from "@/domain/recurringScheduleEdit";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";

const MONTHLY_ITEM_ID = "93b749ac-32f1-42e7-b228-bdf218b37126";
const MONTHLY_TITLE = "Вносить отчётность по всем проектам";
const TARGET_ITEM_ID = "e0cd618f-7a0b-4990-bd9e-d5450a228a4d";
const TARGET_TITLE = "Придумать интеграцию кэфов во все наши трансляции";
const JUNK_ITEMS = [
  {
    id: "a9b0a670-3b78-4a2c-b8e8-46e18a0ee5b8",
    title: "Повторяющееся напоминание",
  },
  {
    id: "f2b5d087-f0af-4373-9290-ed074424ce11",
    title: "Повторять каждые 4 часа",
  },
] as const;
const REPAIR_MARKER = "v306_recurring_incident_2026_09_07";
const ITEM_REPAIR_FLAG = "v306RecurringIncidentRepairDone";

export async function repairV306RecurringIncident(params?: { now?: Date }) {
  const now = params?.now ?? new Date();
  const monthly = await getPlannerItemByAnyId(MONTHLY_ITEM_ID);
  const target = await getPlannerItemByAnyId(TARGET_ITEM_ID);
  const ownerId = monthly?.userId ?? target?.userId ?? null;
  if (!ownerId) return { checked: true, changed: false, reason: "incident_items_not_found" };

  const changes: string[] = [];

  if (
    monthly &&
    monthly.userId === ownerId &&
    monthly.title === MONTHLY_TITLE &&
    monthly.metadata?.[ITEM_REPAIR_FLAG] !== true
  ) {
    let activeMonthly = monthly;
    if (monthly.status === "completed") {
      const restored = await restoreCompletedPlannerItem({ userId: ownerId, itemId: monthly.id });
      if (restored) {
        activeMonthly = restored;
        changes.push("restored_monthly_parent");
      }
    }
    if (activeMonthly.status === "active") {
      const monthlyPolicies = await listReminderPoliciesForItem(ownerId, monthly.id, 100);
      const existingMonthly =
        monthlyPolicies.find((policy) =>
          ["recurring", "long_term"].includes(policy.policyType) &&
          typeof policy.recurrenceRule === "string" &&
          /monthly/i.test(policy.recurrenceRule),
        ) ??
        monthlyPolicies.find((policy) => ["recurring", "long_term"].includes(policy.policyType)) ??
        null;
      const timezone = monthly.timezone || "Europe/Moscow";
      const recurrenceRule = existingMonthly?.recurrenceRule || "monthly_days:1@09:00";
      const nextFireAt =
        nextRecurringOccurrence({ rule: recurrenceRule, after: now, timezone }) ??
        nextFirstOfMonthAtNine(now, timezone);
      const alreadyHealthy =
        existingMonthly?.status === "active" &&
        existingMonthly.nextFireAt &&
        existingMonthly.nextFireAt > now &&
        existingMonthly.metadata?.recurringParentPersistent === true &&
        existingMonthly.metadata?.stopOnItemComplete !== true;

      let policy = existingMonthly;
      if (!alreadyHealthy) {
        if (existingMonthly) {
          await cancelPendingRemindersForPolicy({
            userId: ownerId,
            policyId: existingMonthly.id,
            from: new Date(0),
          });
        }
        policy = existingMonthly
          ? await updateReminderPolicy({
              userId: ownerId,
              policyId: existingMonthly.id,
              itemId: monthly.id,
              status: "active",
              title: monthly.title,
              policyType: existingMonthly.policyType === "long_term" ? "long_term" : "recurring",
              startsAt: existingMonthly.startsAt ?? nextFireAt,
              endsAt: null,
              nextFireAt,
              recurrenceRule,
              requireAck: true,
              snoozedUntil: null,
              snoozeScope: null,
              metadata: {
                repairMarker: REPAIR_MARKER,
                repairedAt: now.toISOString(),
                recurringParentPersistent: true,
                stopOnItemComplete: false,
              },
            })
          : null;
        if (!policy) {
          policy = await createReminderPolicyIfMissing({
            userId: ownerId,
            itemId: monthly.id,
            title: monthly.title,
            category: monthly.category ?? "recurring",
            policyType: "long_term",
            timezone,
            startsAt: nextFireAt,
            endsAt: null,
            nextFireAt,
            recurrenceRule: "monthly_days:1@09:00",
            requireAck: true,
            catchUpMode: "one_immediate_then_resume",
            onWindowEnd: "expire_silently",
            idempotencyKey: `${REPAIR_MARKER}:${monthly.id}:monthly`,
            metadata: {
              repairMarker: REPAIR_MARKER,
              repairedAt: now.toISOString(),
              recurringParentPersistent: true,
              stopOnItemComplete: false,
            },
          });
        }
        changes.push("reactivated_monthly_policy");
      }
      if (policy) {
        await materializeNextPolicyReminder(policy, policy.nextFireAt ?? nextFireAt, { now });
        await updatePlannerItemDetails({
          userId: ownerId,
          itemId: monthly.id,
          metadata: {
            [ITEM_REPAIR_FLAG]: true,
            v306RecurringIncidentRepairAt: now.toISOString(),
            recurringParentPersistent: true,
          },
        });
      }
    }
  }

  for (const candidate of JUNK_ITEMS) {
    const item = await getPlannerItemByAnyId(candidate.id);
    if (!item || item.userId !== ownerId || item.title !== candidate.title || item.status !== "active") {
      continue;
    }
    await cancelItemReminders(ownerId, item.id);
    await stopPoliciesForItem(ownerId, item.id, "cancelled");
    const cancelled = await cancelPlannerItemWithMetadata({
      userId: ownerId,
      itemId: item.id,
      metadata: {
        repairMarker: REPAIR_MARKER,
        cancelReason: "junk_created_by_failed_schedule_edit",
        repairedAt: now.toISOString(),
      },
    });
    if (cancelled) changes.push(`cancelled_junk:${item.id}`);
  }

  if (
    target &&
    target.userId === ownerId &&
    target.title === TARGET_TITLE &&
    target.status === "active" &&
    target.metadata?.[ITEM_REPAIR_FLAG] !== true
  ) {
    const timezone = target.timezone || "Europe/Moscow";
    const rule = buildRecurringScheduleRule({
      preset: "daily",
      timeLocal: "08:00",
      now,
      timezone,
    });
    const timing = resolveRecurringScheduleTiming({
      rule,
      preset: "daily",
      timeLocal: "08:00",
      intervalMinutes: 240,
      after: now,
      timezone,
    });
    if (timing) {
      const policies = await listReminderPoliciesForItem(ownerId, target.id, 100);
      const existing =
        policies.find((policy) =>
          ["recurring", "long_term"].includes(policy.policyType) && policy.status === "active",
        ) ??
        policies.find((policy) => ["recurring", "long_term"].includes(policy.policyType)) ??
        null;
      const alreadyHealthy =
        existing?.status === "active" &&
        existing.recurrenceRule === rule &&
        existing.intervalMinutes === 240 &&
        existing.metadata?.activeWindowStart === "08:00" &&
        existing.metadata?.activeWindowEnd === "23:59" &&
        existing.metadata?.stopOnItemComplete === true &&
        existing.metadata?.recurringParentPersistent !== true;
      let policy = existing;
      if (!alreadyHealthy) {
        if (existing) {
          await cancelPendingRemindersForPolicy({
            userId: ownerId,
            policyId: existing.id,
            from: new Date(0),
          });
        }
        const metadata = {
          repairMarker: REPAIR_MARKER,
          repairedAt: now.toISOString(),
          configuredFrom: "recovered_failed_schedule_edit",
          schedulePreset: "daily",
          activeWindowStart: "08:00",
          activeWindowEnd: "23:59",
          recurringParentPersistent: false,
          stopOnItemComplete: true,
          stopCondition: "until_done",
          moveToNextDaySuppressesCurrentWindow: true,
        };
        policy = existing
          ? await updateReminderPolicy({
              userId: ownerId,
              policyId: existing.id,
              itemId: target.id,
              status: "active",
              title: target.title,
              policyType: "recurring",
              startsAt: timing.startsAt,
              endsAt: null,
              nextFireAt: timing.nextFireAt,
              recurrenceRule: rule,
              intervalMinutes: 240,
              requireAck: true,
              snoozedUntil: null,
              snoozeScope: null,
              metadata,
            })
          : null;
        if (!policy) {
          policy = await createReminderPolicyIfMissing({
            userId: ownerId,
            itemId: target.id,
            title: target.title,
            category: target.category ?? "recurring",
            policyType: "recurring",
            timezone,
            startsAt: timing.startsAt,
            endsAt: null,
            nextFireAt: timing.nextFireAt,
            recurrenceRule: rule,
            intervalMinutes: 240,
            requireAck: true,
            catchUpMode: "one_immediate_then_resume",
            onWindowEnd: "expire_silently",
            idempotencyKey: `${REPAIR_MARKER}:${target.id}:daily-4h`,
            metadata,
          });
        }
        changes.push("recovered_target_daily_4h_schedule");
      }
      if (policy) {
        await materializeNextPolicyReminder(policy, policy.nextFireAt ?? timing.nextFireAt, { now });
        await updatePlannerItemDetails({
          userId: ownerId,
          itemId: target.id,
          metadata: {
            [ITEM_REPAIR_FLAG]: true,
            v306RecurringIncidentRepairAt: now.toISOString(),
          },
        });
      }
    }
  }

  if (changes.length) {
    await writeAudit({
      userId: ownerId,
      action: "assistant.v306_recurring_incident_repaired",
      entityType: "repair",
      entityId: REPAIR_MARKER,
      details: { changes, repairedAt: now.toISOString() },
    }).catch(() => undefined);
  }

  return { checked: true, changed: changes.length > 0, changes };
}

function nextFirstOfMonthAtNine(now: Date, timezone: string) {
  const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  let candidate = local.startOf("month").set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  if (candidate <= local) candidate = candidate.plus({ months: 1 });
  return candidate.toUTC().toJSDate();
}
