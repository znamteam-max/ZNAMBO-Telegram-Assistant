import { DateTime } from "luxon";

import {
  getLatestAgentActionByStatus,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import type { AgentAction } from "@/db/schema";

const ACTION_TYPE = "pending_plan_edit_session";
const DEFAULT_TTL_MINUTES = 30;

export type ActivePendingPlanEditSession = {
  action: AgentAction;
  actionPlanId: string;
  expiresAt: Date;
};

export async function startPendingPlanEditSession(params: {
  userId: string;
  actionPlanId: string;
  sourceMessageId?: string | null;
  now?: Date;
}) {
  await clearPendingPlanEditSession({
    userId: params.userId,
    reason: "replaced_by_new_plan_edit_session",
  });
  const now = params.now ?? new Date();
  const expiresAt = DateTime.fromJSDate(now, { zone: "utc" })
    .plus({ minutes: DEFAULT_TTL_MINUTES })
    .toJSDate();
  return recordAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: ACTION_TYPE,
    status: "pending",
    input: {
      actionPlanId: params.actionPlanId,
    },
    output: {
      actionPlanId: params.actionPlanId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
  });
}

export async function getActivePendingPlanEditSession(params: {
  userId: string;
  now?: Date;
}): Promise<ActivePendingPlanEditSession | null> {
  const now = params.now ?? new Date();
  const action = await getLatestAgentActionByStatus({
    userId: params.userId,
    actionType: ACTION_TYPE,
    status: "pending",
  });
  if (!action) return null;
  const output = action.output ?? {};
  const actionPlanId =
    typeof output.actionPlanId === "string"
      ? output.actionPlanId
      : typeof action.input?.actionPlanId === "string"
        ? action.input.actionPlanId
        : null;
  const expiresAt = parseDate(output.expiresAt);
  if (!actionPlanId || !expiresAt || expiresAt <= now) {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...output,
        cancelledReason: "expired_or_invalid",
        cancelledAt: now.toISOString(),
      },
    });
    return null;
  }
  return { action, actionPlanId, expiresAt };
}

export async function clearPendingPlanEditSession(params: {
  userId: string;
  reason?: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const action = await getLatestAgentActionByStatus({
    userId: params.userId,
    actionType: ACTION_TYPE,
    status: "pending",
  });
  if (!action) return null;
  return updateAgentAction({
    userId: params.userId,
    actionId: action.id,
    status: "cancelled",
    output: {
      ...(action.output ?? {}),
      cancelledReason: params.reason ?? "cleared",
      cancelledAt: now.toISOString(),
    },
  });
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
