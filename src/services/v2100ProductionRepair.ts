import { writeAudit } from "@/db/queries/audit";
import { cancelPlannerItemWithMetadata, listManageableItems } from "@/db/queries/items";
import {
  listActiveReminderPolicies,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelPendingRemindersForPolicy } from "@/db/queries/reminders";

const MONDAY_CADENCE_TITLE = /^кажд(?:ый|ую)\s+понедельник(?:ам)?[.!]?$/i;

export function isV2100CadenceTitleGarbage(title: string) {
  return MONDAY_CADENCE_TITLE.test(title.trim().toLocaleLowerCase("ru").replace(/ё/g, "е"));
}

export async function previewV2100ProductionRepair(params: { userId: string }) {
  const [items, policies] = await Promise.all([
    listManageableItems(params.userId, 400),
    listActiveReminderPolicies(params.userId, 400),
  ]);
  const garbageTasks = items.filter(
    (item) =>
      item.status === "active" &&
      item.kind === "task" &&
      isV2100CadenceTitleGarbage(item.title),
  );
  const garbageTaskIds = new Set(garbageTasks.map((item) => item.id));
  const garbagePolicies = policies.filter(
    (policy) =>
      (policy.itemId ? garbageTaskIds.has(policy.itemId) : false) ||
      isV2100CadenceTitleGarbage(policy.title),
  );
  return {
    garbageTasks,
    garbagePolicies,
    calendarObjectsToDelete: 0,
    safeToApply: garbageTasks.length === 1,
  };
}

export async function applyV2100ProductionRepair(params: { userId: string }) {
  const preview = await previewV2100ProductionRepair(params);
  const archivedItemIds: string[] = [];
  const archivedPolicyIds: string[] = [];
  if (!preview.safeToApply) {
    return { preview, archivedItemIds, archivedPolicyIds, calendarObjectsChanged: 0 };
  }

  for (const policy of preview.garbagePolicies) {
    await cancelPendingRemindersForPolicy({
      userId: params.userId,
      policyId: policy.id,
    });
    const archived = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      status: "cancelled",
      nextFireAt: null,
      metadata: {
        archivedBy: "admin_repair_v2100",
        archiveReason: "cadence_title_without_action_object",
      },
    });
    if (archived) archivedPolicyIds.push(archived.id);
  }

  for (const item of preview.garbageTasks) {
    const archived = await cancelPlannerItemWithMetadata({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        archivedBy: "admin_repair_v2100",
        archiveReason: "cadence_title_without_action_object",
      },
    });
    if (archived) archivedItemIds.push(archived.id);
  }

  await writeAudit({
    userId: params.userId,
    action: "assistant.v2100_production_repair",
    entityType: "production_repair",
    details: {
      repairVersion: "2.10.0",
      archivedItemIds,
      archivedPolicyIds,
      calendarObjectsChanged: 0,
    },
  }).catch(() => undefined);

  return { preview, archivedItemIds, archivedPolicyIds, calendarObjectsChanged: 0 };
}
