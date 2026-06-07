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

export async function applyAgentItemUpdates(params: {
  userId: string;
  updates: AgentItemUpdate[];
  timezone: string;
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

      if (update.operation === "complete") {
        const completed = await markPlannerItemCompleted(params.userId, item.id);
        await cancelItemReminderChains(params.userId, [item.id]);
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
          const reminder = await createReminderIfMissing({
            userId: params.userId,
            plannerItemId: item.id,
            type: "event_before",
            idempotencyKey: `${item.id}:agent-before:${update.reminderMinutesBefore}:${scheduledAt.toISOString()}`,
            scheduledAt,
            payload: {
              title: item.title,
              agentConfigured: true,
              minutesBefore: update.reminderMinutesBefore,
            },
          });
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
          const reminder = await createReminderIfMissing({
            userId: params.userId,
            plannerItemId: item.id,
            type: item.kind === "training" ? "training_followup" : "followup",
            idempotencyKey: `${item.id}:agent-followup:${update.followupMinutesAfter}:${intendedScheduledAt.toISOString()}`,
            scheduledAt,
            payload: {
              title: item.title,
              agentConfigured: true,
              minutesAfter: update.followupMinutesAfter,
              prompt: `Как прошло: ${item.title}?`,
            },
          });
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
      payload: { ...payload, rescheduledByAgent: true },
    });
    if (created) reminderIds.push(created.id);
  }
  return reminderIds;
}
