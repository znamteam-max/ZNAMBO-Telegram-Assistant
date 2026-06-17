import { InlineKeyboard } from "grammy";

import {
  listDuePendingAgentActionsByType,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import { writeAudit } from "@/db/queries/audit";
import { getUserById } from "@/db/queries/users";
import type { AgentAction } from "@/db/schema";
import type { ReminderTelegramSender } from "@/jobs/runDueReminders";

export const PENDING_PROMPT_RENAG_ACTION = "pending_prompt_renag_session";

export async function recordPendingPromptRenag(params: {
  userId: string;
  promptType: string;
  text: string;
  targetItemId?: string | null;
  targetReminderId?: string | null;
  targetPolicyId?: string | null;
  now?: Date;
  expiresAt?: Date | null;
}) {
  const now = params.now ?? new Date();
  const expiresAt = params.expiresAt ?? new Date(now.getTime() + 30 * 60_000);
  const action = await recordAgentAction({
    userId: params.userId,
    actionType: PENDING_PROMPT_RENAG_ACTION,
    status: "pending",
    input: {
      promptType: params.promptType,
      targetItemId: params.targetItemId ?? null,
      targetReminderId: params.targetReminderId ?? null,
      targetPolicyId: params.targetPolicyId ?? null,
    },
    output: {
      text: params.text,
      lastSentAt: now.toISOString(),
      nextRenagAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      renagCount: 0,
      expiresAt: expiresAt.toISOString(),
    },
  });
  await writeAudit({
    userId: params.userId,
    action: "assistant.pending_prompt_created",
    entityType: "agent_action",
    entityId: action?.id ?? undefined,
    details: {
      promptType: params.promptType,
      targetItemId: params.targetItemId ?? null,
      targetReminderId: params.targetReminderId ?? null,
      targetPolicyId: params.targetPolicyId ?? null,
      nextRenagAt: action?.output?.nextRenagAt ?? null,
    },
  }).catch(() => undefined);
  return action;
}

export async function cancelPendingPromptRenagsForTarget(params: {
  userId: string;
  targetItemId?: string | null;
  targetReminderId?: string | null;
  targetPolicyId?: string | null;
  reason?: string;
}) {
  const due = await listDuePendingAgentActionsByType({
    actionType: PENDING_PROMPT_RENAG_ACTION,
    now: new Date("9999-12-31T00:00:00.000Z"),
    limit: 200,
  });
  const matched = due.filter(
    (action) =>
      action.userId === params.userId &&
      (!params.targetItemId || action.input?.targetItemId === params.targetItemId) &&
      (!params.targetReminderId || action.input?.targetReminderId === params.targetReminderId) &&
      (!params.targetPolicyId || action.input?.targetPolicyId === params.targetPolicyId),
  );
  for (const action of matched) {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...(action.output ?? {}),
        cancelledAt: new Date().toISOString(),
        cancelledReason: params.reason ?? "target_answered",
      },
    });
  }
  return matched.length;
}

export async function runDuePendingPromptRenags(params: {
  now: Date;
  sender: ReminderTelegramSender;
  limit?: number;
}) {
  const actions = await listDuePendingAgentActionsByType({
    actionType: PENDING_PROMPT_RENAG_ACTION,
    now: params.now,
    limit: params.limit ?? 10,
  });
  let sent = 0;
  let cancelled = 0;
  for (const action of actions) {
    if (!action.userId) continue;
    const expiresAt = parseDate(action.output?.expiresAt);
    if (expiresAt && expiresAt <= params.now) {
      await cancelAction(action, "expired");
      cancelled += 1;
      continue;
    }
    const user = await getUserById(action.userId);
    if (!user) {
      await cancelAction(action, "user_not_found");
      cancelled += 1;
      continue;
    }
    const text = typeof action.output?.text === "string" ? action.output.text : null;
    if (!text) {
      await cancelAction(action, "missing_text");
      cancelled += 1;
      continue;
    }
    const message = await params.sender.sendMessage(user.telegramUserId.toString(), text, {
      reply_markup: renagFallbackKeyboard(action),
    });
    const renagCount = Number(action.output?.renagCount ?? 0) + 1;
    await updateAgentAction({
      userId: user.id,
      actionId: action.id,
      status: "pending",
      output: {
        ...(action.output ?? {}),
        lastSentAt: params.now.toISOString(),
        nextRenagAt: new Date(params.now.getTime() + 5 * 60_000).toISOString(),
        renagCount,
        lastTelegramMessageId: message.message_id ?? null,
      },
    });
    await writeAudit({
      userId: user.id,
      action: "assistant.pending_prompt_renag_sent",
      entityType: "agent_action",
      entityId: action.id,
      details: { renagCount, messageId: message.message_id ?? null },
    }).catch(() => undefined);
    sent += 1;
  }
  return { checked: actions.length, sent, cancelled };
}

function renagFallbackKeyboard(action: AgentAction) {
  const reminderId =
    typeof action.input?.targetReminderId === "string" ? action.input.targetReminderId : null;
  if (reminderId)
    return new InlineKeyboard().text("К напоминанию", `event_reminder:again:${reminderId}`);
  return new InlineKeyboard().text("К плану", "dashboard:refresh");
}

async function cancelAction(action: AgentAction, reason: string) {
  if (!action.userId) return;
  await updateAgentAction({
    userId: action.userId,
    actionId: action.id,
    status: "cancelled",
    output: {
      ...(action.output ?? {}),
      cancelledAt: new Date().toISOString(),
      cancelledReason: reason,
    },
  });
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
