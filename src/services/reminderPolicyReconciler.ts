import {
  getPolicySlotState,
  getPendingReminderForPolicy,
  listActivePoliciesForReconciliation,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { restorePolicyReminder } from "@/db/queries/reminders";
import {
  computeNextPolicySlotAfterDelivery,
  resolvePolicyReconcileTarget,
} from "@/domain/reminderPolicySchedule";

import { materializeNextPolicyReminder } from "./reminderPolicyEngine";

export async function reconcileActiveReminderPolicies(params?: {
  now?: Date;
  limit?: number;
}) {
  const now = params?.now ?? new Date();
  const policies = await listActivePoliciesForReconciliation(params?.limit ?? 200);
  let materialized = 0;
  let advanced = 0;
  let expired = 0;

  for (const policy of policies) {
    const existingPending = await getPendingReminderForPolicy(policy.id);
    if (existingPending) continue;
    const target = resolvePolicyReconcileTarget(policy, now);
    if (!target) {
      if (
        ["interval_window", "nag_until_ack"].includes(policy.policyType) &&
        policy.endsAt &&
        now > policy.endsAt
      ) {
        await updateReminderPolicy({
          policyId: policy.id,
          userId: policy.userId,
          status: "completed",
          nextFireAt: null,
          metadata: { reconciledExpiredAt: now.toISOString() },
        });
        expired += 1;
      }
      continue;
    }

    const slot = await getPolicySlotState(policy.id, target.scheduledFor);
    if (slot?.reminder?.status === "sent") {
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
        ? { lastCatchUpAt: now.toISOString(), catchUpScheduledFor: target.scheduledFor.toISOString() }
        : undefined,
    });
    const reminder = await materializeNextPolicyReminder(
      { ...policy, nextFireAt: target.scheduledFor },
      target.scheduledFor,
      {
        now,
        deliveryAt: target.deliveryAt,
        catchUp: target.catchUp,
      },
    );
    if (reminder) materialized += 1;
  }

  return {
    checked: policies.length,
    materialized,
    advanced,
    expired,
  };
}
