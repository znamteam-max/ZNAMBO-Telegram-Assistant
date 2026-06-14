import { DateTime } from "luxon";

import {
  getLatestAgentActionByStatus,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import { getPlannerItemById } from "@/db/queries/items";
import type { AgentAction, PlannerItem } from "@/db/schema";

const ACTION_TYPE = "reminder_policy_edit_session";
const TTL_MINUTES = 30;

export type ActiveReminderPolicyEditSession = {
  action: AgentAction;
  item: PlannerItem;
  section: string;
  expiresAt: Date;
  draft: ReminderPolicyEditDraft;
};

export type ReminderPolicyEditDraft = {
  intervalMinutes?: number;
  windowStart?: string;
  windowEnd?: string | null;
  windowEndDayOffset?: number;
  stopCondition?: "until_done";
  ackAliases?: string[];
};

export async function startReminderPolicyEditSession(params: {
  userId: string;
  itemId: string;
  section: string;
  sourceMessageId?: string | null;
  now?: Date;
}) {
  await clearActiveReminderPolicyEditSession({
    userId: params.userId,
    reason: "replaced_by_new_reminder_policy_edit_session",
  });
  const now = params.now ?? new Date();
  const expiresAt = DateTime.fromJSDate(now, { zone: "utc" }).plus({ minutes: TTL_MINUTES }).toJSDate();
  return recordAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: ACTION_TYPE,
    status: "pending",
    input: { itemId: params.itemId, section: params.section },
    output: {
      itemId: params.itemId,
      section: params.section,
      expiresAt: expiresAt.toISOString(),
      draft: {},
    },
  });
}

export async function getActiveReminderPolicyEditSession(params: {
  userId: string;
  now?: Date;
}): Promise<ActiveReminderPolicyEditSession | null> {
  const now = params.now ?? new Date();
  const action = await getLatestAgentActionByStatus({
    userId: params.userId,
    actionType: ACTION_TYPE,
    status: "pending",
  });
  if (!action) return null;
  const itemId = typeof action.output?.itemId === "string" ? action.output.itemId : null;
  const section = typeof action.output?.section === "string" ? action.output.section : "custom";
  const expiresAt = parseDate(action.output?.expiresAt);
  const draft = parseDraft(action.output?.draft);
  if (!itemId || !expiresAt || expiresAt <= now) {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: { ...(action.output ?? {}), cancelledReason: "expired_or_invalid" },
    });
    return null;
  }
  const item = await getPlannerItemById(params.userId, itemId);
  if (!item || item.status !== "active") {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: { ...(action.output ?? {}), cancelledReason: "item_missing_or_inactive" },
    });
    return null;
  }
  return { action, item, section, expiresAt, draft };
}

export async function updateReminderPolicyEditSessionDraft(params: {
  userId: string;
  actionId: string;
  draft: ReminderPolicyEditDraft;
}) {
  const action = await getLatestAgentActionByStatus({
    userId: params.userId,
    actionType: ACTION_TYPE,
    status: "pending",
  });
  if (!action || action.id !== params.actionId) return null;
  return updateAgentAction({
    userId: params.userId,
    actionId: action.id,
    status: "pending",
    output: {
      ...(action.output ?? {}),
      draft: {
        ...parseDraft(action.output?.draft),
        ...params.draft,
      },
      updatedAt: new Date().toISOString(),
    },
  });
}

export async function clearActiveReminderPolicyEditSession(params: {
  userId: string;
  reason?: string;
}) {
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
      cancelledAt: new Date().toISOString(),
    },
  });
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDraft(value: unknown): ReminderPolicyEditDraft {
  if (!value || typeof value !== "object") return {};
  const draft = value as Record<string, unknown>;
  return {
    ...(typeof draft.intervalMinutes === "number"
      ? { intervalMinutes: draft.intervalMinutes }
      : {}),
    ...(typeof draft.windowStart === "string" ? { windowStart: draft.windowStart } : {}),
    ...(typeof draft.windowEnd === "string" || draft.windowEnd === null
      ? { windowEnd: draft.windowEnd as string | null }
      : {}),
    ...(typeof draft.windowEndDayOffset === "number"
      ? { windowEndDayOffset: draft.windowEndDayOffset }
      : {}),
    ...(draft.stopCondition === "until_done"
      ? { stopCondition: "until_done" as const }
      : {}),
    ...(Array.isArray(draft.ackAliases)
      ? { ackAliases: draft.ackAliases.filter((entry): entry is string => typeof entry === "string") }
      : {}),
  };
}
