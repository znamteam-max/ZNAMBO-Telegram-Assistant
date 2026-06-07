import { DateTime } from "luxon";

import type { AgentItemUpdate } from "@/ai/schemas/agentExecution";
import {
  markPlannerItemCompleted,
  mergePlannerItemMetadata,
  updatePlannerItemSchedule,
} from "@/db/queries/items";
import {
  cancelItemReminderChains,
  createReminderIfMissing,
  listActiveRemindersForItems,
} from "@/db/queries/reminders";
import { listItemsByIds } from "@/db/queries/taskViewStates";
import type { PlannerItem } from "@/db/schema";
import { localIsoToUtcDate } from "@/domain/dateTime";
import {
  attachOccurrenceReminder,
  createPolicyOccurrence,
  createReminderPolicyIfMissing,
  stopPoliciesForItem,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";

export async function applyAgentItemUpdates(params: {
  userId: string;
  updates: AgentItemUpdate[];
  timezone: string;
  sourceText?: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const updates = mergeUpdatesByItemId(params.updates);
  const requestedIds = updates.map((update) => update.itemIds[0]);
  const items = await listItemsByIds(params.userId, requestedIds);
  const byId = new Map(items.map((item) => [item.id, item]));
  const updatedItems: PlannerItem[] = [];
  const reminderIds: string[] = [];
  const warnings: string[] = [];
  const completedItemIds: string[] = [];
  const rescheduledItemIds: string[] = [];
  const configuredItemIds: string[] = [];
  let exposeManagementButtons = false;

  for (const update of updates) {
    exposeManagementButtons ||= update.exposeManagementButtons;
    for (const itemId of update.itemIds) {
      const item = byId.get(itemId);
      if (!item) {
        warnings.push(`item_not_found:${itemId}`);
        continue;
      }
      if (item.status !== "active") {
        warnings.push(`item_not_active:${itemId}`);
        continue;
      }

      if (update.operation === "complete") {
        const completed = await markPlannerItemCompleted(params.userId, item.id);
        await cancelItemReminderChains(params.userId, [item.id]);
        await stopPoliciesForItem(params.userId, item.id);
        if (completed) {
          updatedItems.push(completed);
          completedItemIds.push(completed.id);
        }
        continue;
      }

      if (update.operation === "reschedule") {
        const rescheduled = await rescheduleItem({
          userId: params.userId,
          item,
          update,
          timezone: item.timezone || params.timezone,
          sourceText: params.sourceText,
          now,
        });
        if (rescheduled.item) {
          updatedItems.push(rescheduled.item);
          rescheduledItemIds.push(rescheduled.item.id);
        }
        reminderIds.push(...rescheduled.reminderIds);
        warnings.push(...rescheduled.warnings);
        continue;
      }

      const start = item.startAt ?? item.dueAt;
      if (!start) {
        warnings.push(`item_has_no_time:${itemId}`);
        continue;
      }

      if (update.reminderMinutesBefore) {
        const scheduledAt = DateTime.fromJSDate(start, { zone: "utc" })
          .minus({ minutes: update.reminderMinutesBefore })
          .toJSDate();
        if (scheduledAt > now) {
          const policy = await createReminderPolicyIfMissing({
            userId: params.userId,
            itemId: item.id,
            title: item.title,
            category: "pre_event",
            policyType: "before_event",
            timezone: item.timezone || params.timezone,
            startsAt: scheduledAt,
            nextFireAt: scheduledAt,
            requireAck: false,
            idempotencyKey: `${item.id}:agent-before:${update.reminderMinutesBefore}:${scheduledAt.toISOString()}`,
            metadata: { minutesBefore: update.reminderMinutesBefore, agentConfigured: true },
          });
          const reminder = await materializeNextPolicyReminder(policy, scheduledAt);
          if (reminder) reminderIds.push(reminder.id);
        } else {
          warnings.push(`reminder_in_past:${itemId}`);
        }
      }

      if (update.followupMinutesAfter !== null) {
        const base = item.endAt ?? DateTime.fromJSDate(start, { zone: "utc" }).plus({ minutes: 60 }).toJSDate();
        const intendedScheduledAt = DateTime.fromJSDate(base, { zone: "utc" })
          .plus({ minutes: update.followupMinutesAfter })
          .toJSDate();
        const catchupWindowMs = 24 * 60 * 60 * 1000;
        const isRecentPast =
          intendedScheduledAt <= now && now.getTime() - intendedScheduledAt.getTime() <= catchupWindowMs;
        const scheduledAt = isRecentPast
          ? DateTime.fromJSDate(now, { zone: "utc" }).plus({ minutes: 1 }).toJSDate()
          : intendedScheduledAt;
        if (scheduledAt > now) {
          const policy = await createReminderPolicyIfMissing({
            userId: params.userId,
            itemId: item.id,
            title: item.title,
            category: "post_event",
            policyType: "post_event_menu",
            timezone: item.timezone || params.timezone,
            startsAt: intendedScheduledAt,
            nextFireAt: scheduledAt,
            requireAck: false,
            idempotencyKey: `${item.id}:agent-followup:${update.followupMinutesAfter}:${intendedScheduledAt.toISOString()}`,
            metadata: {
              minutesAfter: update.followupMinutesAfter,
              agentConfigured: true,
              catchup: isRecentPast,
            },
          });
          const reminder = await materializeNextPolicyReminder(policy, scheduledAt);
          if (reminder) reminderIds.push(reminder.id);
          if (isRecentPast) warnings.push(`followup_catchup_scheduled:${itemId}`);
        } else {
          warnings.push(`followup_in_past:${itemId}`);
        }
      }

      const updated = await mergePlannerItemMetadata({
        userId: params.userId,
        itemId: item.id,
        metadata: {
          agentUpdatedAt: now.toISOString(),
          agentUpdateOperation: update.operation,
          managementButtonsRequested: update.exposeManagementButtons,
          agentUpdateNote: update.note,
        },
      });
      if (updated) {
        updatedItems.push(updated);
        configuredItemIds.push(updated.id);
      }
    }
  }

  return {
    updatedItems: dedupeItems(updatedItems),
    reminderIds,
    warnings: [...new Set(warnings)],
    exposeManagementButtons,
    completedItemIds: [...new Set(completedItemIds)],
    rescheduledItemIds: [...new Set(rescheduledItemIds)],
    configuredItemIds: [...new Set(configuredItemIds)],
  };
}

function dedupeItems(items: PlannerItem[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function mergeUpdatesByItemId(updates: AgentItemUpdate[]): AgentItemUpdate[] {
  const merged = new Map<string, AgentItemUpdate>();
  for (const update of updates) {
    for (const itemId of update.itemIds) {
      const current = merged.get(itemId);
      merged.set(itemId, {
        itemIds: [itemId],
        operation: mergeOperation(current?.operation, update.operation),
        startAtLocal: update.startAtLocal ?? current?.startAtLocal ?? null,
        endAtLocal: update.endAtLocal ?? current?.endAtLocal ?? null,
        reminderMinutesBefore:
          update.reminderMinutesBefore ?? current?.reminderMinutesBefore ?? null,
        followupMinutesAfter:
          update.followupMinutesAfter ?? current?.followupMinutesAfter ?? null,
        exposeManagementButtons:
          Boolean(current?.exposeManagementButtons) || update.exposeManagementButtons,
        note: [current?.note, update.note].filter(Boolean).join(" | ") || null,
      });
    }
  }
  return [...merged.values()];
}

function mergeOperation(
  current: AgentItemUpdate["operation"] | undefined,
  incoming: AgentItemUpdate["operation"],
) {
  const priority = { configure: 1, reschedule: 2, complete: 3 } as const;
  if (!current || priority[incoming] >= priority[current]) return incoming;
  return current;
}

async function rescheduleItem(params: {
  userId: string;
  item: PlannerItem;
  update: AgentItemUpdate;
  timezone: string;
  sourceText?: string;
  now: Date;
}) {
  const warnings: string[] = [];
  const oldAnchor = params.item.startAt ?? params.item.dueAt;
  if (!oldAnchor && !params.update.startAtLocal) {
    return {
      item: null,
      reminderIds: [] as string[],
      warnings: [`reschedule_missing_start:${params.item.id}`],
    };
  }

  const newAnchor = params.update.startAtLocal
    ? localIsoToUtcDate(params.update.startAtLocal, params.timezone)
    : oldAnchor!;
  const oldDurationMs =
    params.item.startAt && params.item.endAt
      ? params.item.endAt.getTime() - params.item.startAt.getTime()
      : null;
  const newEnd = params.update.endAtLocal
    ? localIsoToUtcDate(params.update.endAtLocal, params.timezone)
    : oldDurationMs !== null
      ? new Date(newAnchor.getTime() + oldDurationMs)
      : params.item.endAt;
  const timeValidation = validateExplicitScheduleTimes({
    sourceText: params.sourceText,
    item: params.item,
    update: params.update,
    timezone: params.timezone,
  });
  if (!timeValidation.ok) {
    return {
      item: null,
      reminderIds: [] as string[],
      warnings: [`explicit_time_mismatch:${params.item.id}`],
    };
  }
  const taskLike = params.item.kind === "task" || params.item.kind === "recurring_task";
  const activeReminders = await listActiveRemindersForItems(params.userId, [params.item.id]);

  const updated = await updatePlannerItemSchedule({
    userId: params.userId,
    itemId: params.item.id,
    startAt: taskLike ? null : newAnchor,
    endAt: taskLike ? null : newEnd,
    dueAt: taskLike ? newAnchor : null,
    metadata: {
      agentUpdatedAt: params.now.toISOString(),
      agentUpdateOperation: "reschedule",
      managementButtonsRequested: params.update.exposeManagementButtons,
      agentUpdateNote: params.update.note,
    },
  });
  if (!updated) {
    return {
      item: null,
      reminderIds: [] as string[],
      warnings: [`reschedule_failed:${params.item.id}`],
    };
  }

  const reminderIds = await recreateRemindersAfterReschedule({
    userId: params.userId,
    item: updated,
    oldAnchor,
    reminders: activeReminders,
    now: params.now,
  });
  if (activeReminders.length && !reminderIds.length) {
    warnings.push(`rescheduled_reminders_not_future:${params.item.id}`);
  }
  return { item: updated, reminderIds, warnings };
}

function validateExplicitScheduleTimes(params: {
  sourceText?: string;
  item: PlannerItem;
  update: AgentItemUpdate;
  timezone: string;
}) {
  const explicitTimes = extractExplicitClockTimes(params.sourceText ?? "");
  if (!explicitTimes.size) return { ok: true };
  const existingTimes = new Set(
    [params.item.startAt, params.item.endAt, params.item.dueAt]
      .filter((value): value is Date => Boolean(value))
      .map((value) =>
        DateTime.fromJSDate(value, { zone: "utc" }).setZone(params.timezone).toFormat("HH:mm"),
      ),
  );
  const proposedTimes = [params.update.startAtLocal, params.update.endAtLocal]
    .filter((value): value is string => Boolean(value))
    .map((value) =>
      DateTime.fromJSDate(localIsoToUtcDate(value, params.timezone), { zone: "utc" })
        .setZone(params.timezone)
        .toFormat("HH:mm"),
    );
  return {
    ok: proposedTimes.every((value) => explicitTimes.has(value) || existingTimes.has(value)),
  };
}

function extractExplicitClockTimes(text: string) {
  const times = new Set<string>();
  const withMinutes = text.matchAll(/\b(\d{1,2})[.:](\d{2})\b/g);
  for (const match of withMinutes) {
    times.add(`${String(Number(match[1])).padStart(2, "0")}:${match[2]}`);
  }
  const bareAfterPreposition = text.matchAll(
    /(?:^|\s)(?:в|на|с|до)\s+(\d{1,2})(?!\d|[.:]\d)/gi,
  );
  for (const match of bareAfterPreposition) {
    times.add(`${String(Number(match[1])).padStart(2, "0")}:00`);
  }
  return times;
}

async function recreateRemindersAfterReschedule(params: {
  userId: string;
  item: PlannerItem;
  oldAnchor: Date | null;
  reminders: Awaited<ReturnType<typeof listActiveRemindersForItems>>;
  now: Date;
}) {
  if (!params.reminders.length) return [];
  await cancelItemReminderChains(params.userId, [params.item.id]);
  const newAnchor = params.item.startAt ?? params.item.dueAt;
  if (!newAnchor) return [];
  const reminderIds: string[] = [];

  for (const reminder of params.reminders) {
    const payload = reminder.payload ?? {};
    let scheduledAt: Date;
    if (reminder.type === "event_before") {
      const minutesBefore = Number(payload.minutesBefore ?? 60);
      scheduledAt = DateTime.fromJSDate(newAnchor, { zone: "utc" })
        .minus({ minutes: minutesBefore })
        .toJSDate();
    } else if (reminder.type === "followup" || reminder.type === "training_followup") {
      const minutesAfter = Number(payload.minutesAfter ?? 15);
      const base =
        params.item.endAt ??
        DateTime.fromJSDate(newAnchor, { zone: "utc" }).plus({ minutes: 60 }).toJSDate();
      scheduledAt = DateTime.fromJSDate(base, { zone: "utc" })
        .plus({ minutes: minutesAfter })
        .toJSDate();
    } else {
      const deltaMs = params.oldAnchor ? newAnchor.getTime() - params.oldAnchor.getTime() : 0;
      scheduledAt = new Date(reminder.scheduledAt.getTime() + deltaMs);
    }
    if (scheduledAt <= params.now) continue;
    const created = await createReminderIfMissing({
      userId: params.userId,
      plannerItemId: params.item.id,
      type: reminder.type,
      idempotencyKey: `${params.item.id}:rescheduled:${reminder.type}:${scheduledAt.toISOString()}`,
      scheduledAt,
      repeatUntilAck: reminder.repeatUntilAck,
      recurrenceKey: reminder.recurrenceKey,
      policyId: reminder.policyId,
      purpose: reminder.purpose,
      menuType: reminder.menuType,
      autoDeleteAfterResponse: reminder.autoDeleteAfterResponse,
      payload: { ...payload, rescheduledByAgent: true },
    });
    if (reminder.policyId) {
      await updateReminderPolicy({
        policyId: reminder.policyId,
        userId: params.userId,
        nextFireAt: scheduledAt,
      });
    }
    if (created) {
      reminderIds.push(created.id);
      if (reminder.policyId) {
        await createPolicyOccurrence({
          policyId: reminder.policyId,
          reminderId: created.id,
          scheduledFor: scheduledAt,
          metadata: { rescheduledByAgent: true },
        });
        await attachOccurrenceReminder({
          policyId: reminder.policyId,
          scheduledFor: scheduledAt,
          reminderId: created.id,
        });
      }
    }
  }
  return reminderIds;
}
