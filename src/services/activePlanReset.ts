import { getAgentActionById, recordAgentAction, updateAgentAction } from "@/db/queries/agentActions";
import {
  cancelCalendarSyncJobsForItem,
  cancelPlannerItemWithMetadata,
  listAllActiveItems,
} from "@/db/queries/items";
import {
  cancelItemReminderChains,
  listActiveRemindersForItems,
} from "@/db/queries/reminders";
import type { PlannerItem } from "@/db/schema";
import { isGarbageOrTestItem } from "@/domain/itemVisibility";

export type ActivePlanResetMode = "all" | "garbage";

export type ActivePlanResetPreview = {
  openItemCount: number;
  resettableItemCount: number;
  garbageItemCount: number;
  testItemCount: number;
  activeReminderCount: number;
  recurringPreservedCount: number;
};

export async function prepareActivePlanReset(params: {
  userId: string;
  sourceMessageId?: string | null;
  mode: ActivePlanResetMode;
}) {
  const { allItems, selectedItems, reminders, preview } = await buildResetSelection(params.userId, params.mode);
  const action = await recordAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "reset_active_plan",
    status: "pending",
    input: { mode: params.mode },
    output: {
      preview,
      selectedItemIds: selectedItems.map((item) => item.id),
      openItemIds: allItems.map((item) => item.id),
      activeReminderIds: reminders.map((reminder) => reminder.id),
    },
  });
  if (!action) throw new Error("Reset preview action was not created");
  return { action, preview, selectedItems };
}

export async function executeActivePlanReset(params: {
  userId: string;
  actionId?: string | null;
  mode: ActivePlanResetMode;
  reason?: string;
}) {
  const pendingAction = params.actionId
    ? await getAgentActionById({ userId: params.userId, actionId: params.actionId })
    : null;
  if (pendingAction && pendingAction.status !== "pending") {
    return { status: "already_handled" as const, action: pendingAction, items: [] as PlannerItem[] };
  }

  const { selectedItems, reminders, preview } = await buildResetSelection(params.userId, params.mode);
  const reason =
    params.reason ??
    (params.mode === "garbage" ? "production_garbage_cleanup" : "user_confirmed_active_plan_reset");
  const cancelled: PlannerItem[] = [];

  for (const item of selectedItems) {
    const updated = await cancelPlannerItemWithMetadata({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        archivedBy: "active_plan_reset",
        archivedAt: new Date().toISOString(),
        garbage: params.mode === "garbage" ? true : item.metadata?.garbage === true,
        garbageReason: params.mode === "garbage" ? reasonForGarbage(item) : item.metadata?.garbageReason,
        resetReason: reason,
      },
    });
    await cancelCalendarSyncJobsForItem(item.id);
    if (updated) cancelled.push(updated);
  }
  await cancelItemReminderChains(params.userId, selectedItems.map((item) => item.id));

  const undoPayload = {
    items: selectedItems.map((item) => ({
      id: item.id,
      status: item.status,
      completedAt: item.completedAt?.toISOString() ?? null,
      metadata: item.metadata,
    })),
    reminders: reminders.map((reminder) => ({
      id: reminder.id,
      status: reminder.status,
      scheduledAt: reminder.scheduledAt.toISOString(),
    })),
  };
  const output = {
    preview,
    cancelledItemIds: cancelled.map((item) => item.id),
    cancelledReminderIds: reminders.map((reminder) => reminder.id),
  };

  const action = params.actionId
    ? await updateAgentAction({
        userId: params.userId,
        actionId: params.actionId,
        status: "completed",
        output,
        undoPayload,
      })
    : await recordAgentAction({
        userId: params.userId,
        actionType: "reset_active_plan",
        status: "completed",
        input: { mode: params.mode, reason },
        output,
        undoPayload,
      });

  return { status: "completed" as const, action, items: cancelled, preview };
}

export async function cancelActivePlanReset(params: { userId: string; actionId: string }) {
  return updateAgentAction({
    userId: params.userId,
    actionId: params.actionId,
    status: "cancelled",
    output: { cancelledByUser: true },
  });
}

async function buildResetSelection(userId: string, mode: ActivePlanResetMode) {
  const allItems = await listAllActiveItems(userId, 500);
  const garbageItems = allItems.filter(isGarbageOrTestItem);
  const selectedItems =
    mode === "garbage"
      ? garbageItems
      : allItems.filter((item) => item.kind !== "recurring_task");
  const reminders = await listActiveRemindersForItems(
    userId,
    selectedItems.map((item) => item.id),
  );
  const preview: ActivePlanResetPreview = {
    openItemCount: allItems.length,
    resettableItemCount: selectedItems.length,
    garbageItemCount: garbageItems.length,
    testItemCount: allItems.filter((item) => item.metadata?.isTest === true || item.metadata?.debug === true).length,
    activeReminderCount: reminders.length,
    recurringPreservedCount: allItems.filter((item) => item.kind === "recurring_task").length,
  };
  return { allItems, garbageItems, selectedItems, reminders, preview };
}

function reasonForGarbage(item: PlannerItem) {
  if (item.metadata?.isTest === true || item.metadata?.debug === true) return "test_or_debug_item";
  if (String(item.title).includes("\n") || String(item.description ?? "").includes("\n")) {
    return "legacy_multiline_update_saved_as_single_event";
  }
  return "production_garbage_cleanup";
}
