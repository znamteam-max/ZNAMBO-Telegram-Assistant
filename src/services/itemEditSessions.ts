import { DateTime } from "luxon";

import {
  getLatestAgentActionByStatus,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import { getPlannerItemById } from "@/db/queries/items";
import type { AgentAction, PlannerItem } from "@/db/schema";

export type ItemEditMode = "general" | "time";

export type ActiveItemEditSession = {
  action: AgentAction;
  item: PlannerItem;
  itemId: string;
  mode: ItemEditMode;
  expiresAt: Date;
};

const ACTION_TYPE = "item_edit_session";
const DEFAULT_TTL_MINUTES = 30;

export async function startItemEditSession(params: {
  userId: string;
  itemId: string;
  mode: ItemEditMode;
  sourceMessageId?: string | null;
  sourceTelegramMessageId?: number | null;
  now?: Date;
}) {
  await clearActiveItemEditSession({
    userId: params.userId,
    reason: "replaced_by_new_item_edit_session",
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
      activeEditItemId: params.itemId,
      activeEditMode: params.mode,
      sourceTelegramMessageId: params.sourceTelegramMessageId ?? null,
    },
    output: {
      activeEditItemId: params.itemId,
      activeEditMode: params.mode,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      sourceTelegramMessageId: params.sourceTelegramMessageId ?? null,
    },
  });
}

export async function getActiveItemEditSession(params: {
  userId: string;
  now?: Date;
}): Promise<ActiveItemEditSession | null> {
  const now = params.now ?? new Date();
  const action = await getLatestAgentActionByStatus({
    userId: params.userId,
    actionType: ACTION_TYPE,
    status: "pending",
  });
  if (!action) return null;
  const output = action.output ?? {};
  const itemId = typeof output.activeEditItemId === "string" ? output.activeEditItemId : null;
  const rawMode = typeof output.activeEditMode === "string" ? output.activeEditMode : "general";
  const expiresAt = parseDate(output.expiresAt);
  if (!itemId || !expiresAt || expiresAt <= now) {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: { ...output, cancelledReason: "expired_or_invalid", cancelledAt: now.toISOString() },
    });
    return null;
  }
  const item = await getPlannerItemById(params.userId, itemId);
  if (!item || item.status !== "active") {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: { ...output, cancelledReason: "item_missing_or_inactive", cancelledAt: now.toISOString() },
    });
    return null;
  }
  return {
    action,
    item,
    itemId,
    mode: rawMode === "time" ? "time" : "general",
    expiresAt,
  };
}

export async function clearActiveItemEditSession(params: {
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
