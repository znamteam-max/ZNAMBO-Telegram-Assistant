import { getPendingReminderForPolicy, listActiveReminderPolicies, updateReminderPolicy } from "@/db/queries/reminderPolicies";
import { writeAudit } from "@/db/queries/audit";
import {
  currentCanonicalOccurrenceIfDue,
  resolvePolicyReconcileTarget,
} from "@/domain/reminderPolicySchedule";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";

import {
  applyV2190ProductionRepair,
  previewV2190ProductionRepair,
} from "./v2190ProductionRepair";

export async function previewV2200ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const [base, monthlyDayRangeSkippedTodayPolicyIds] = await Promise.all([
    previewV2190ProductionRepair(params),
    collectMonthlyDayRangeSkippedTodayPolicyIds(params.userId, now),
  ]);
  return {
    ...base,
    monthlyDayRangeSkippedTodayPolicyIds,
    monthlyDayRangeSkippedTodayPolicies: monthlyDayRangeSkippedTodayPolicyIds.length,
    missingEventFollowupReminderIds: [] as string[],
    missingEventFollowupReminders: 0,
    callbackPayloadTooLongRecords: 0,
    calendarObjectsToChange: 0 as const,
    safeToApply: true as const,
    notes: [
      ...(base.notes ?? []),
      `monthly day-range skipped today: ${monthlyDayRangeSkippedTodayPolicyIds.length}`,
      "event follow-up reconstruction is audit-only unless a future target is provable",
      "callback payload repair is code-level; database rows are not mutated",
      "Yandex Calendar objects will not be changed",
    ],
  };
}

export async function applyV2200ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const base = await applyV2190ProductionRepair(params);
  const skippedPolicyIds = await collectMonthlyDayRangeSkippedTodayPolicyIds(params.userId, now);
  const materializedMonthlyPolicyIds: string[] = [];

  for (const policy of await listActiveReminderPolicies(params.userId, 500)) {
    if (!skippedPolicyIds.includes(policy.id)) continue;
    const target = resolvePolicyReconcileTarget(policy, now);
    if (!target) continue;
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      nextFireAt: target.scheduledFor,
      status: "active",
      snoozedUntil: null,
      snoozeScope: null,
      metadata: {
        repairedBy: "admin_repair_v2200",
        repairedAt: now.toISOString(),
        repairReason: "monthly_day_range_skipped_current_valid_day",
        catchUpScheduledFor: target.catchUp ? target.scheduledFor.toISOString() : null,
      },
    });
    const reminder = updated
      ? await materializeNextPolicyReminder(updated, target.scheduledFor, {
          now,
          deliveryAt: target.deliveryAt,
          catchUp: target.catchUp,
        }).catch(() => null)
      : null;
    if (reminder) {
      materializedMonthlyPolicyIds.push(policy.id);
      await writeAudit({
        userId: params.userId,
        action: "assistant.monthly_policy_materialized",
        entityType: "reminder_policy",
        entityId: policy.id,
        details: {
          repairedBy: "admin_repair_v2200",
          reminderId: reminder.id,
          scheduledFor: target.scheduledFor.toISOString(),
          deliveryAt: target.deliveryAt.toISOString(),
          catchUp: target.catchUp,
        },
      }).catch(() => undefined);
    }
  }

  return {
    ...base,
    monthlyDayRangeSkippedTodayPolicyIds: skippedPolicyIds,
    monthlyDayRangeSkippedTodayPolicies: skippedPolicyIds.length,
    materializedMonthlyPolicyIds,
    missingEventFollowupReminderIds: [] as string[],
    missingEventFollowupReminders: 0,
    callbackPayloadTooLongRecords: 0,
    calendarObjectsChanged: 0 as const,
    calendarObjectsToChange: 0 as const,
    safeToApply: true as const,
  };
}

async function collectMonthlyDayRangeSkippedTodayPolicyIds(userId: string, now: Date) {
  const result: string[] = [];
  const policies = await listActiveReminderPolicies(userId, 500);
  for (const policy of policies) {
    if (!/^monthly_days:/i.test(policy.recurrenceRule ?? "")) continue;
    if (policy.snoozedUntil && policy.snoozedUntil > now) continue;
    const currentDue = currentCanonicalOccurrenceIfDue(policy, now);
    if (!currentDue) continue;
    const pending = await getPendingReminderForPolicy(policy.id);
    if (pending) continue;
    if (!policy.nextFireAt || policy.nextFireAt.getTime() !== currentDue.getTime()) {
      result.push(policy.id);
    }
  }
  return result;
}
