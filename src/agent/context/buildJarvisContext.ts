import { buildActiveContext } from "@/services/contextRetrieval";
import { logger } from "@/lib/logger";

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

  return {
    now,
    timezone: params.timezone,
    activeContext: [
      activeContextResult.activeContext,
      "",
      "Last task view state:",
      lastTaskViewState
        ? `- ${lastTaskViewState.title}; scope=${lastTaskViewState.scope}; items=${lastTaskViewState.itemIds.length}`
        : "- none",
    ].join("\n"),
    contextError: activeContextResult.contextError,
    lastTaskViewState,
  };
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
