import type { PlannerItem, TaskViewState } from "@/db/schema";
import {
  getLatestTaskViewState,
  saveTaskViewState,
  type TaskViewScope,
} from "@/db/queries/taskViewStates";
import { logger } from "@/lib/logger";

export async function rememberTaskView(params: {
  userId: string;
  scope: TaskViewScope;
  title: string;
  items: PlannerItem[];
  metadata?: Record<string, unknown>;
}): Promise<TaskViewState | null> {
  try {
    return await saveTaskViewState({
      ...params,
      ttlMinutes: 12 * 60,
    });
  } catch (error) {
    logger.warn("Task view state save failed", {
      error: error instanceof Error ? error.message : String(error),
      scope: params.scope,
    });
    return null;
  }
}

export async function loadLatestTaskView(userId: string, scope?: TaskViewScope | null) {
  return getLatestTaskViewState({ userId, scope });
}

export function itemIdsForDisplayIndices(
  viewState: TaskViewState | null,
  indices: number[],
): string[] {
  if (!viewState || !indices.length) return [];
  const snapshots = Array.isArray(viewState.itemsSnapshot)
    ? (viewState.itemsSnapshot as Array<{ displayIndex?: number; itemId?: string }>)
    : [];
  const byDisplayIndex = new Map(
    snapshots
      .filter((item) => typeof item.displayIndex === "number" && typeof item.itemId === "string")
      .map((item) => [item.displayIndex as number, item.itemId as string]),
  );
  return indices.map((index) => byDisplayIndex.get(index)).filter((id): id is string => Boolean(id));
}
