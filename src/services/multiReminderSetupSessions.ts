import { DateTime } from "luxon";

import {
  getLatestAgentActionByStatus,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import { getPlannerItemById } from "@/db/queries/items";
import type { AgentAction, PlannerItem } from "@/db/schema";

import { clearActiveItemEditSession } from "./itemEditSessions";
import { clearActiveReminderPolicyEditSession } from "./reminderPolicyEditSessions";

const ACTION_TYPE = "multi_reminder_setup_session";
const TTL_MINUTES = 30;

export type ActiveMultiReminderSetupSession = {
  action: AgentAction;
  item: PlannerItem;
  itemId: string;
  expiresAt: Date;
};

export async function startMultiReminderSetupSession(params: {
  userId: string;
  itemId: string;
  sourceMessageId?: string | null;
  sourceTelegramMessageId?: number | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  await Promise.all([
    clearActiveMultiReminderSetupSession({
      userId: params.userId,
      reason: "replaced_by_new_multi_reminder_setup_session",
      now,
    }),
    clearActiveItemEditSession({
      userId: params.userId,
      reason: "superseded_by_multi_reminder_setup_session",
      now,
    }),
    clearActiveReminderPolicyEditSession({
      userId: params.userId,
      reason: "superseded_by_multi_reminder_setup_session",
    }),
  ]);
  const expiresAt = DateTime.fromJSDate(now, { zone: "utc" })
    .plus({ minutes: TTL_MINUTES })
    .toJSDate();
  return recordAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: ACTION_TYPE,
    status: "pending",
    input: {
      itemId: params.itemId,
      sourceTelegramMessageId: params.sourceTelegramMessageId ?? null,
    },
    output: {
      itemId: params.itemId,
      activeSessionType: ACTION_TYPE,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      sourceTelegramMessageId: params.sourceTelegramMessageId ?? null,
    },
  });
}

export async function getActiveMultiReminderSetupSession(params: {
  userId: string;
  now?: Date;
}): Promise<ActiveMultiReminderSetupSession | null> {
  const now = params.now ?? new Date();
  const action = await getLatestAgentActionByStatus({
    userId: params.userId,
    actionType: ACTION_TYPE,
    status: "pending",
  });
  if (!action) return null;
  const itemId = typeof action.output?.itemId === "string" ? action.output.itemId : null;
  const expiresAt = parseDate(action.output?.expiresAt);
  if (!itemId || !expiresAt || expiresAt <= now) {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...(action.output ?? {}),
        cancelledReason: "expired_or_invalid",
        cancelledAt: now.toISOString(),
      },
    });
    return null;
  }
  const item = await getPlannerItemById(params.userId, itemId);
  if (!item || item.status !== "active") {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...(action.output ?? {}),
        cancelledReason: "item_missing_or_inactive",
        cancelledAt: now.toISOString(),
      },
    });
    return null;
  }
  return { action, item, itemId, expiresAt };
}

export async function clearActiveMultiReminderSetupSession(params: {
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
