import { DateTime } from "luxon";

import { getPlannerItemById, updatePlannerItemDetails } from "@/db/queries/items";
import {
  getPolicyForReminder,
  listReminderPoliciesForItem,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import {
  ackReminderForToday,
  cancelPendingRemindersForPolicy,
} from "@/db/queries/reminders";
import { writeAudit } from "@/db/queries/audit";
import { endOfLocalDay, startOfLocalDay } from "@/domain/dateTime";
import { computeNextPolicySlotAfterDelivery } from "@/domain/reminderPolicySchedule";
import { nextRecurringOccurrence } from "@/domain/recurringPolicySemantics";
import {
  nextRecurringScheduleOccurrence,
  type RecurringSchedulePreset,
} from "@/domain/recurringScheduleEdit";
import {
  acknowledgePolicyReminder,
  materializeNextPolicyReminder,
} from "@/services/reminderPolicyEngine";
import type { ReminderPolicy } from "@/db/schema";

const PERSISTENT_POLICY_TYPES = new Set(["recurring", "long_term"]);
const SCHEDULE_PRESETS = new Set<RecurringSchedulePreset>([
  "daily",
  "weekdays",
  "weekly",
  "every_2_weeks",
  "monthly",
  "yearly",
]);

export async function completePersistentRecurringItemCycle(params: {
  userId: string;
  itemId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const item = await getPlannerItemById(params.userId, params.itemId);
  if (!item || item.status !== "active") return { handled: false as const, item: null };

  const candidatePolicies = (await listReminderPoliciesForItem(params.userId, item.id, 100)).filter(
    (policy) => policy.status === "active" && PERSISTENT_POLICY_TYPES.has(policy.policyType),
  );
  const policies = candidatePolicies.filter((policy) =>
    isPersistentRecurringParent({ itemKind: item.kind, policy }),
  );
  if (item.kind !== "recurring_task" && !policies.length) {
    return { handled: false as const, item };
  }

  const timezone = item.timezone || params.timezone;
  const nextOccurrences: Array<{ policyId: string; nextFireAt: string | null }> = [];
  for (const policy of policies) {
    const nextFireAt = nextBaseOccurrenceAfterCurrentCycle(policy, now, timezone);
    if (nextFireAt) {
      await cancelPendingRemindersForPolicy({
        userId: params.userId,
        policyId: policy.id,
        from: new Date(0),
      });
      const updated = await updateReminderPolicy({
        userId: params.userId,
        policyId: policy.id,
        status: "active",
        nextFireAt,
        snoozedUntil: null,
        snoozeScope: null,
        metadata: {
          lastOccurrenceCompletedAt: now.toISOString(),
          recurringParentPersistent: true,
          stopOnItemComplete: false,
        },
      });
      if (updated) await materializeNextPolicyReminder(updated, nextFireAt, { now });
    }
    nextOccurrences.push({
      policyId: policy.id,
      nextFireAt: nextFireAt?.toISOString() ?? policy.nextFireAt?.toISOString() ?? null,
    });
  }

  const updatedItem =
    (await updatePlannerItemDetails({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        lastOccurrenceCompletedAt: now.toISOString(),
        recurringParentPersistent: true,
        recurringParentCompletionMode: "occurrence_only",
      },
    })) ?? item;

  await writeAudit({
    userId: params.userId,
    action: "assistant.recurring_occurrence_completed",
    entityType: "planner_item",
    entityId: item.id,
    details: {
      operation: "ack_occurrence_only",
      parentStatus: updatedItem.status,
      parentKeptActive: true,
      policyCount: policies.length,
      nextOccurrences,
    },
  }).catch(() => undefined);

  return {
    handled: true as const,
    item: updatedItem,
    policyCount: policies.length,
    nextOccurrences,
  };
}

export async function acknowledgePersistentRecurringReminder(params: {
  userId: string;
  reminderId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const row = await getPolicyForReminder(params.reminderId);
  if (
    !row ||
    row.policy.userId !== params.userId ||
    !PERSISTENT_POLICY_TYPES.has(row.policy.policyType)
  ) {
    return { handled: false as const, itemId: row?.policy.itemId ?? null };
  }
  const item = row.policy.itemId
    ? await getPlannerItemById(params.userId, row.policy.itemId)
    : null;
  if (!isPersistentRecurringParent({ itemKind: item?.kind, policy: row.policy })) {
    return { handled: false as const, itemId: row.policy.itemId };
  }
  const timezone = item?.timezone || row.policy.timezone || params.timezone;

  await ackReminderForToday({
    userId: params.userId,
    reminderId: params.reminderId,
    dayStart: startOfLocalDay(now, timezone),
    dayEnd: endOfLocalDay(now, timezone),
  });
  await acknowledgePolicyReminder(params.reminderId);

  const nextFireAt = nextBaseOccurrenceAfterCurrentCycle(row.policy, now, timezone);
  if (nextFireAt) {
    await cancelPendingRemindersForPolicy({
      userId: params.userId,
      policyId: row.policy.id,
      from: new Date(0),
    });
    const updatedPolicy = await updateReminderPolicy({
      userId: params.userId,
      policyId: row.policy.id,
      status: "active",
      nextFireAt,
      snoozedUntil: null,
      snoozeScope: null,
      metadata: {
        lastOccurrenceCompletedAt: now.toISOString(),
        recurringParentPersistent: true,
        stopOnItemComplete: false,
      },
    });
    if (updatedPolicy) await materializeNextPolicyReminder(updatedPolicy, nextFireAt, { now });
  }

  if (item?.status === "active") {
    await updatePlannerItemDetails({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        lastOccurrenceCompletedAt: now.toISOString(),
        recurringParentPersistent: true,
        recurringParentCompletionMode: "occurrence_only",
      },
    });
  }

  await writeAudit({
    userId: params.userId,
    action: "assistant.recurring_occurrence_completed",
    entityType: "reminder_policy",
    entityId: row.policy.id,
    details: {
      reminderId: params.reminderId,
      itemId: row.policy.itemId,
      operation: "ack_occurrence_only",
      parentKeptActive: true,
      nextFireAt: nextFireAt?.toISOString() ?? null,
    },
  }).catch(() => undefined);

  return {
    handled: true as const,
    itemId: row.policy.itemId,
    nextFireAt,
  };
}

export function isPersistentRecurringPolicy(
  policy: Pick<ReminderPolicy, "policyType"> | null | undefined,
) {
  return Boolean(policy && PERSISTENT_POLICY_TYPES.has(policy.policyType));
}

export function isPersistentRecurringParent(params: {
  itemKind?: string | null;
  policy?: Pick<ReminderPolicy, "policyType" | "metadata"> | null;
}) {
  if (params.itemKind === "recurring_task") return true;
  const policy = params.policy;
  if (!policy || !PERSISTENT_POLICY_TYPES.has(policy.policyType)) return false;
  return (
    policy.metadata?.recurringParentPersistent === true &&
    policy.metadata?.stopOnItemComplete !== true
  );
}

function nextBaseOccurrenceAfterCurrentCycle(
  policy: ReminderPolicy,
  now: Date,
  timezone: string,
) {
  const boundary = endOfLocalDay(now, timezone);
  const canonical = nextRecurringOccurrence({
    rule: policy.recurrenceRule,
    after: boundary,
    timezone,
  });
  if (canonical) return canonical;

  const presetValue = policy.metadata?.schedulePreset;
  const preset =
    typeof presetValue === "string" && SCHEDULE_PRESETS.has(presetValue as RecurringSchedulePreset)
      ? (presetValue as RecurringSchedulePreset)
      : null;
  if (preset) {
    const timeLocal =
      typeof policy.metadata?.activeWindowStart === "string"
        ? policy.metadata.activeWindowStart
        : policy.nextFireAt
          ? DateTime.fromJSDate(policy.nextFireAt, { zone: "utc" })
              .setZone(timezone)
              .toFormat("HH:mm")
          : "09:00";
    const next = nextRecurringScheduleOccurrence({
      rule: policy.recurrenceRule ?? "",
      preset,
      timeLocal,
      after: boundary,
      timezone,
    });
    if (next) return next;
  }

  const fallback = computeNextPolicySlotAfterDelivery({
    policy,
    scheduledFor: boundary,
    now: boundary,
  });
  return fallback && fallback > boundary ? fallback : null;
}
