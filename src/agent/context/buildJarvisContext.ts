import { buildActiveContext } from "@/services/contextRetrieval";
import { logger } from "@/lib/logger";
import { listItemsByIds } from "@/db/queries/taskViewStates";
import { isActiveItem } from "@/domain/itemVisibility";

import { loadLatestTaskView } from "../state/taskViewState";
import type { JarvisContext } from "../types";

export async function buildJarvisContext(params: {
  userId: string;
  timezone: string;
  query: string;
  now?: Date;
}): Promise<JarvisContext> {
  const now = params.now ?? new Date();
  const [activeContextResult, lastTaskViewState] = await Promise.all([
    buildActiveContextBestEffort({ ...params, now }),
    loadLatestTaskViewBestEffort(params.userId),
  ]);
  const activeTaskViewItems = lastTaskViewState
    ? await loadActiveTaskViewItemsBestEffort(params.userId, lastTaskViewState.itemIds)
    : [];

  return {
    now,
    timezone: params.timezone,
    activeContext: [
      activeContextResult.activeContext,
      "",
      "Last task view state:",
      lastTaskViewState
        ? [
            `- ${lastTaskViewState.title}; scope=${lastTaskViewState.scope}; activeItems=${activeTaskViewItems.length}`,
            ...activeTaskViewItems.map(
              (item, index) =>
                `  ${index + 1}. id=${item.id}; status=${item.status}; ${item.kind}; ${item.title}; startAt=${item.startAt?.toISOString() ?? "none"}; endAt=${item.endAt?.toISOString() ?? "none"}; dueAt=${item.dueAt?.toISOString() ?? "none"}`,
            ),
          ].join("\n")
        : "- none",
    ].join("\n"),
    contextError: activeContextResult.contextError,
    lastTaskViewState,
  };
}

async function loadActiveTaskViewItemsBestEffort(userId: string, itemIds: string[]) {
  try {
    const items = await listItemsByIds(userId, itemIds);
    return items.filter(isActiveItem);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Jarvis active task-view item retrieval failed", { error: message });
    return [];
  }
}

async function loadLatestTaskViewBestEffort(userId: string) {
  try {
    return await loadLatestTaskView(userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Jarvis task view retrieval failed", { error: message });
    return null;
  }
}

async function buildActiveContextBestEffort(params: {
  userId: string;
  timezone: string;
  query: string;
  now: Date;
}) {
  try {
    return {
      activeContext: await buildActiveContext(params),
      contextError: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Jarvis context retrieval failed", { error: message });
    return {
      activeContext: `Context retrieval failed; continue without blocking. Error: ${message}`,
      contextError: message,
    };
  }
}
