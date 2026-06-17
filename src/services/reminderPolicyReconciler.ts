import {
  expirePolicyAndCancelFutureReminders,
  getPolicySlotState,
  getPendingReminderForPolicy,
  listActivePoliciesForReconciliation,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { restorePolicyReminder } from "@/db/queries/reminders";
import { writeAudit } from "@/db/queries/audit";
import {
  computeNextPolicySlotAfterDelivery,
  currentCanonicalOccurrenceIfDue,
  resolvePolicyReconcileTarget,
} from "@/domain/reminderPolicySchedule";

import { materializeNextPolicyReminder } from "./reminderPolicyEngine";

export async function reconcileActiveReminderPolicies(params?: { now?: Date; limit?: number }) {
  const now = params?.now ?? new Date();
  const policies = await listActivePoliciesForReconciliation(params?.limit ?? 200);
  let materialized = 0;
  let advanced = 0;
  let expired = 0;

  for (const policy of policies) {
    if (policy.snoozedUntil && policy.snoozedUntil > now) continue;
    if (
      ["interval_window", "nag_until_ack"].includes(policy.policyType) &&
      policy.endsAt &&
      now > policy.endsAt &&
      policy.onWindowEnd !== "carry_to_next_day"
    ) {
      await expirePolicyAndCancelFutureReminders({
        policyId: policy.id,
        userId: policy.userId,
        expiredAt: now,
      });
      expired += 1;
      continue;
    }
    const monthlyCurrentDue = isMonthlyDayRangePolicy(policy)
      ? currentCanonicalOccurrenceIfDue(policy, now)
      : null;
    if (monthlyCurrentDue) {
      await writeMonthlyDayRangeAudit(policy, "assistant.monthly_day_range_occurrence_checked", {
        scheduledFor: monthlyCurrentDue.toISOString(),
        hasNextFireAt: Boolean(policy.nextFireAt),
        nextFireAt: policy.nextFireAt?.toISOString() ?? null,
      });
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
  await writeAudit({
    userId: policy.userId,
    action,
    entityType: "reminder_policy",
    entityId: policy.id,
    details: {
      recurrenceRule: policy.recurrenceRule,
      timezone: policy.timezone,
      ...details,
    },
  }).catch(() => undefined);
}
