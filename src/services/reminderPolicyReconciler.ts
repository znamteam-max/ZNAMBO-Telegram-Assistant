import { DateTime } from "luxon";

import { getPlannerItemById, updatePlannerItemDetails } from "@/db/queries/items";
import {
  expirePolicyAndCancelFutureReminders,
  getPolicySlotState,
  getPendingReminderForPolicy,
  listActivePoliciesForReconciliation,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import {
  cancelPendingRemindersForPolicy,
  restorePolicyReminder,
} from "@/db/queries/reminders";
import { writeAudit, writeAuditOnceByKey } from "@/db/queries/audit";
import {
  computeNextPolicySlotAfterDelivery,
  currentCanonicalOccurrenceIfDue,
  resolvePolicyReconcileTarget,
} from "@/domain/reminderPolicySchedule";
import { isTodayUntilDoneReminderPolicy } from "@/domain/todayUntilDoneTask";

import { materializeNextPolicyReminder } from "./reminderPolicyEngine";

export async function reconcileActiveReminderPolicies(params?: { now?: Date; limit?: number }) {
  const now = params?.now ?? new Date();
  const policies = await listActivePoliciesForReconciliation(params?.limit ?? 200);
  let materialized = 0;
  let advanced = 0;
  let expired = 0;

  for (const originalPolicy of policies) {
    let policy = originalPolicy;
    if (policy.snoozedUntil && policy.snoozedUntil > now) continue;
    if (
      ["interval_window", "nag_until_ack"].includes(policy.policyType) &&
      policy.endsAt &&
      now > policy.endsAt &&
      policy.onWindowEnd !== "carry_to_next_day"
    ) {
      if (isTodayUntilDoneReminderPolicy(policy)) {
        const carried = await carryForwardUntilDonePolicy(policy, now);
        if (carried) {
          policy = carried;
        } else {
          await expirePolicyAndCancelFutureReminders({
            policyId: policy.id,
            userId: policy.userId,
            expiredAt: now,
          });
          expired += 1;
          continue;
        }
      } else {
        await expirePolicyAndCancelFutureReminders({
          policyId: policy.id,
          userId: policy.userId,
          expiredAt: now,
        });
        expired += 1;
        continue;
      }
    }
    const monthlyCurrentDue = isMonthlyDayRangePolicy(policy)
      ? currentCanonicalOccurrenceIfDue(policy, now)
      : null;
    if (monthlyCurrentDue) {
      const auditKey = monthlyDayRangeAuditKey(
        policy.id,
        monthlyCurrentDue,
        policy.timezone,
      );
      const written = await writeMonthlyDayRangeAudit(
        policy,
        "assistant.monthly_day_range_occurrence_checked",
        {
          scheduledFor: monthlyCurrentDue.toISOString(),
          hasNextFireAt: Boolean(policy.nextFireAt),
          nextFireAt: policy.nextFireAt?.toISOString() ?? null,
          auditKey,
        },
      );
      if (written) {
        await updateReminderPolicy({
          policyId: policy.id,
          userId: policy.userId,
          metadata: {
            lastMonthlyDayRangeCheckedAuditKey: auditKey,
            lastMonthlyDayRangeCheckedAt: now.toISOString(),
          },
        });
      }
    }
    const existingPending = await getPendingReminderForPolicy(policy.id);
    if (existingPending) continue;
    const target = resolvePolicyReconcileTarget(policy, now);
    if (!target) {
      continue;
    }

    const slot = await getPolicySlotState(policy.id, target.scheduledFor);
    if (
      slot?.reminder?.status === "sent" ||
      slot?.reminder?.status === "acked" ||
      slot?.occurrence?.status === "sent" ||
      slot?.occurrence?.status === "acked" ||
      slot?.occurrence?.status === "skipped"
    ) {
      const next = computeNextPolicySlotAfterDelivery({
        policy,
        scheduledFor: slot.occurrence.scheduledFor,
        now,
      });
      await updateReminderPolicy({
        policyId: policy.id,
        userId: policy.userId,
        nextFireAt: next,
        status: next ? "active" : "completed",
      });
      if (next) {
        const reminder = await materializeNextPolicyReminder(
          { ...policy, nextFireAt: next },
          next,
          { now },
        );
        if (reminder) materialized += 1;
      }
      advanced += 1;
      continue;
    }

    if (slot?.reminder && ["pending", "claimed"].includes(slot.reminder.status)) continue;

    if (slot?.reminder && ["failed", "cancelled"].includes(slot.reminder.status)) {
      const restored = await restorePolicyReminder({
        reminderId: slot.reminder.id,
        scheduledAt: target.deliveryAt,
      });
      if (restored) materialized += 1;
      continue;
    }

    await updateReminderPolicy({
      policyId: policy.id,
      userId: policy.userId,
      nextFireAt: target.scheduledFor,
      metadata: target.catchUp
        ? {
            lastCatchUpAt: now.toISOString(),
            catchUpScheduledFor: target.scheduledFor.toISOString(),
          }
        : undefined,
    });
    if (isMonthlyDayRangePolicy(policy) && target.catchUp) {
      await writeMonthlyDayRangeAudit(
        policy,
        "assistant.monthly_day_range_occurrence_missed_review",
        {
          scheduledFor: target.scheduledFor.toISOString(),
          deliveryAt: target.deliveryAt.toISOString(),
          catchUp: true,
        },
      );
    }
    const reminder = await materializeNextPolicyReminder(
      { ...policy, nextFireAt: target.scheduledFor },
      target.scheduledFor,
      {
        now,
        deliveryAt: target.deliveryAt,
        catchUp: target.catchUp,
      },
    );
    if (reminder) {
      materialized += 1;
      if (/^monthly_days:/i.test(policy.recurrenceRule ?? "")) {
        await writeAudit({
          userId: policy.userId,
          action: "assistant.monthly_policy_materialized",
          entityType: "reminder_policy",
          entityId: policy.id,
          details: {
            scheduledFor: target.scheduledFor.toISOString(),
            deliveryAt: target.deliveryAt.toISOString(),
            catchUp: target.catchUp,
            reminderId: reminder.id,
          },
        }).catch(() => undefined);
        await writeMonthlyDayRangeAudit(
          policy,
          "assistant.monthly_day_range_occurrence_materialized",
          {
            scheduledFor: target.scheduledFor.toISOString(),
            deliveryAt: target.deliveryAt.toISOString(),
            catchUp: target.catchUp,
            reminderId: reminder.id,
          },
        );
      }
    }
  }

  return {
    checked: policies.length,
    materialized,
    advanced,
    expired,
  };
}

function isMonthlyDayRangePolicy(policy: { recurrenceRule: string | null }) {
  return /^monthly_days:/i.test(policy.recurrenceRule ?? "");
}

export function monthlyDayRangeAuditKey(
  policyId: string,
  scheduledFor: Date,
  timezone = "Europe/Moscow",
) {
  const localDate = DateTime.fromJSDate(scheduledFor, { zone: "utc" })
    .setZone(timezone)
    .toISODate();
  return `${policyId}:${localDate}`;
}

async function writeMonthlyDayRangeAudit(
  policy: {
    id: string;
    userId: string;
    recurrenceRule: string | null;
    timezone: string;
  },
  action: string,
  details: Record<string, unknown>,
) {
  const scheduledFor =
    typeof details.scheduledFor === "string"
      ? new Date(details.scheduledFor)
      : null;
  const auditKey =
    typeof details.auditKey === "string"
      ? details.auditKey
      : scheduledFor && !Number.isNaN(scheduledFor.getTime())
        ? monthlyDayRangeAuditKey(policy.id, scheduledFor, policy.timezone)
        : `${policy.id}:state`;
  return writeAuditOnceByKey({
    userId: policy.userId,
    action,
    entityType: "reminder_policy",
    entityId: policy.id,
    auditKey,
    details: {
      recurrenceRule: policy.recurrenceRule,
      timezone: policy.timezone,
      ...details,
    },
  }).catch(() => false);
}

export async function carryForwardUntilDonePolicy(
  policy: Awaited<ReturnType<typeof listActivePoliciesForReconciliation>>[number],
  now: Date,
) {
  if (!policy.itemId) return null;
  const item = await getPlannerItemById(policy.userId, policy.itemId);
  if (!item || item.status !== "active") return null;
  const timezone = item.timezone || policy.timezone || "Europe/Moscow";
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  const startsAt = nowLocal.plus({ minutes: 1 }).set({ second: 0, millisecond: 0 }).toUTC().toJSDate();
  const endsAt = nowLocal
    .set({ hour: 23, minute: 59, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
  if (startsAt > endsAt) return null;

  await cancelPendingRemindersForPolicy({
    userId: policy.userId,
    policyId: policy.id,
    from: new Date(0),
  });
  await updatePlannerItemDetails({
    userId: policy.userId,
    itemId: item.id,
    dueAt: endsAt,
    metadata: {
      untilDoneCarryover: true,
      originalDueAt: item.metadata?.originalDueAt ?? item.dueAt?.toISOString() ?? null,
      activeCarryoverDate: nowLocal.toISODate(),
      carryoverWindowEndLocal: "23:59",
      carriedForwardAt: now.toISOString(),
    },
  });
  return updateReminderPolicy({
    userId: policy.userId,
    policyId: policy.id,
    status: "active",
    startsAt,
    endsAt,
    nextFireAt: startsAt,
    snoozedUntil: null,
    snoozeScope: null,
    metadata: {
      untilDoneCarryover: true,
      activeCarryoverDate: nowLocal.toISODate(),
      carryoverWindowEndLocal: "23:59",
      carriedForwardAt: now.toISOString(),
    },
  });
}
