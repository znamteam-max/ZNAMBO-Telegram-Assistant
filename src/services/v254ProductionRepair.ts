import { getLatestAgentAction } from "@/db/queries/agentActions";
import {
  cancelPlannerItemWithMetadata,
  listAllActiveItems,
  restorePlannerItemStatus,
} from "@/db/queries/items";
import { listItemsByIds } from "@/db/queries/taskViewStates";
import type { PlannerItem } from "@/db/schema";

const KEEP_PATTERNS = [
  /рекап дня на чм-?26/i,
  /эфир студии (централ парк|central park)/i,
  /студия central park/i,
  /отвезти роба к ортодонту/i,
];

const ARCHIVE_PATTERNS = [
  /позвонить дрик по поводу роба/i,
  /записаться к дрик/i,
];

export async function previewV254ProductionRepair(userId: string) {
  const [activeItems, latestDelete] = await Promise.all([
    listAllActiveItems(userId, 500),
    getLatestAgentAction({ userId, actionType: "delete_by_indices" }),
  ]);
  const recentDelete =
    latestDelete &&
    latestDelete.createdAt.getTime() >= Date.now() - 48 * 60 * 60 * 1000
      ? latestDelete
      : null;
  const undoIds = ((recentDelete?.undoPayload?.items ?? []) as Array<{ id?: string }>)
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id));
  const deletedCandidates = await listItemsByIds(userId, undoIds);
  const restore = deletedCandidates.filter(
    (item) => item.status !== "active" && KEEP_PATTERNS.some((pattern) => pattern.test(item.title)),
  );
  const archive = activeItems.filter((item) =>
    ARCHIVE_PATTERNS.some((pattern) => pattern.test(item.title)),
  );
  const retained = activeItems.filter((item) =>
    KEEP_PATTERNS.some((pattern) => pattern.test(item.title)),
  );
  return {
    latestDeleteActionId: recentDelete?.id ?? null,
    retained,
    restore,
    archive,
    notes: [
      "Repair меняет только точно распознанные записи.",
      "Неизвестные reminder policies не удаляются автоматически.",
      "Calendar retry запускается после apply отдельным best-effort шагом.",
    ],
  };
}

export async function applyV254ProductionRepair(userId: string) {
  const preview = await previewV254ProductionRepair(userId);
  const restored: PlannerItem[] = [];
  const archived: PlannerItem[] = [];
  for (const item of preview.restore) {
    const row = await restorePlannerItemStatus({
      userId,
      itemId: item.id,
      status: "active",
      completedAt: null,
    });
    if (row) restored.push(row);
  }
  for (const item of preview.archive) {
    const row = await cancelPlannerItemWithMetadata({
      userId,
      itemId: item.id,
      metadata: {
        archivedBy: "admin_repair_v254",
        repairVersion: "2.5.4",
      },
    });
    if (row) archived.push(row);
  }
  return { ...preview, restored, archived };
}
