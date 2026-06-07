import { DateTime } from "luxon";

import type { AgentItemUpdate } from "@/ai/schemas/agentExecution";
import { mergePlannerItemMetadata } from "@/db/queries/items";
import { createReminderIfMissing } from "@/db/queries/reminders";
import { listItemsByIds } from "@/db/queries/taskViewStates";
import type { PlannerItem } from "@/db/schema";

export async function applyAgentItemUpdates(params: {
  userId: string;
  updates: AgentItemUpdate[];
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const requestedIds = [...new Set(params.updates.flatMap((update) => update.itemIds))];
  const items = await listItemsByIds(params.userId, requestedIds);
  const byId = new Map(items.map((item) => [item.id, item]));
  const updatedItems: PlannerItem[] = [];
  const reminderIds: string[] = [];
  const warnings: string[] = [];
  let exposeManagementButtons = false;

  for (const update of params.updates) {
    exposeManagementButtons ||= update.exposeManagementButtons;
    for (const itemId of update.itemIds) {
      const item = byId.get(itemId);
      if (!item) {
        warnings.push(`item_not_found:${itemId}`);
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
        const scheduledAt = DateTime.fromJSDate(base, { zone: "utc" })
          .plus({ minutes: update.followupMinutesAfter })
          .toJSDate();
        if (scheduledAt > now) {
          const reminder = await createReminderIfMissing({
            userId: params.userId,
            plannerItemId: item.id,
            type: item.kind === "training" ? "training_followup" : "followup",
            idempotencyKey: `${item.id}:agent-followup:${update.followupMinutesAfter}:${scheduledAt.toISOString()}`,
            scheduledAt,
            payload: {
              title: item.title,
              agentConfigured: true,
              prompt: `Как прошло: ${item.title}?`,
            },
          });
          if (reminder) reminderIds.push(reminder.id);
        }
      }

      const updated = await mergePlannerItemMetadata({
        userId: params.userId,
        itemId: item.id,
        metadata: {
          agentUpdatedAt: now.toISOString(),
          managementButtonsRequested: update.exposeManagementButtons,
          agentUpdateNote: update.note,
        },
      });
      if (updated) updatedItems.push(updated);
    }
  }

  return {
    updatedItems: dedupeItems(updatedItems),
    reminderIds,
    warnings: [...new Set(warnings)],
    exposeManagementButtons,
  };
}

function dedupeItems(items: PlannerItem[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

