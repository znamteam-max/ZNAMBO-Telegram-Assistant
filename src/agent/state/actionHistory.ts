import { getLatestAgentAction, recordAgentAction } from "@/db/queries/agentActions";
import { logger } from "@/lib/logger";

export async function rememberAgentAction(params: {
  userId?: string | null;
  sourceMessageId?: string | null;
  actionType: string;
  status?: "pending" | "completed" | "cancelled" | "failed" | "noop" | "undone";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  undoPayload?: Record<string, unknown>;
}) {
  try {
    return await recordAgentAction(params);
  } catch (error) {
    logger.warn("Agent action save failed", {
      error: error instanceof Error ? error.message : String(error),
      actionType: params.actionType,
    });
    return null;
  }
}

export async function loadLatestUndoableAgentAction(userId: string) {
  let latestDelete = null;
  let latestCleanup = null;
  let latestReset = null;
  try {
    latestDelete = await getLatestAgentAction({ userId, actionType: "delete_by_indices" });
    latestCleanup = await getLatestAgentAction({ userId, actionType: "cleanup_garbage" });
    latestReset = await getLatestAgentAction({ userId, actionType: "reset_active_plan" });
  } catch (error) {
    logger.warn("Agent action load failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  return [latestDelete, latestCleanup, latestReset]
    .filter((action) => action?.status === "completed")
    .sort((left, right) => right!.createdAt.getTime() - left!.createdAt.getTime())[0] ?? null;
}
