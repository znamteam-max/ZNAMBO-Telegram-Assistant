import { createHash } from "node:crypto";

import { InlineKeyboard } from "grammy";

import {
  listPendingAgentActionsByTypes,
  listDuePendingAgentActionsByType,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import { writeAudit } from "@/db/queries/audit";
import { getUserById } from "@/db/queries/users";
import type { ReminderTelegramSender } from "@/jobs/runDueReminders";
import { resolveActionableReminderCard } from "@/telegram/reminderCard";
import { auditTelegramDelivery, withTelegramDeliveryPolicy } from "@/telegram/deliveryPolicy";

export const PENDING_PROMPT_RENAG_ACTION = "pending_prompt_renag_session";

export async function recordPendingPromptRenag(params: {
  userId: string;
  promptType: string;
  text: string;
  targetItemId?: string | null;
  targetReminderId?: string | null;
  targetPolicyId?: string | null;
  renderMode?: string | null;
  allowedActions?: string[];
  buttonsAttached?: boolean;
  lastTelegramMessageId?: number | null;
  now?: Date;
  expiresAt?: Date | null;
}) {
  const now = params.now ?? new Date();
  const expiresAt = params.expiresAt ?? new Date(now.getTime() + 30 * 60_000);
  const pending = await listPendingAgentActionsByTypes({
    userId: params.userId,
    actionTypes: [PENDING_PROMPT_RENAG_ACTION],
    limit: 100,
  });
  const newTargetKey = targetGroupKey(params.userId, params);
  for (const existing of pending) {
    if (!newTargetKey || targetKey(existing) !== newTargetKey) continue;
    await updateAgentAction({
      userId: params.userId,
      actionId: existing.id,
      status: "cancelled",
      output: {
        ...(existing.output ?? {}),
        cancelledAt: now.toISOString(),
        cancelledReason: "superseded_by_new_reminder_occurrence",
        supersededAt: now.toISOString(),
      },
    });
  }
  const action = await recordAgentAction({
    userId: params.userId,
    actionType: PENDING_PROMPT_RENAG_ACTION,
    status: "pending",
    input: {
      promptType: params.promptType,
      targetItemId: params.targetItemId ?? null,
      targetReminderId: params.targetReminderId ?? null,
      targetPolicyId: params.targetPolicyId ?? null,
      renderMode: params.renderMode ?? null,
      allowedActions: params.allowedActions ?? [],
      buttonsAttached: params.buttonsAttached ?? false,
    },
    output: {
      text: params.text,
      lastSentAt: now.toISOString(),
      nextRenagAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      renagCount: 0,
      expiresAt: expiresAt.toISOString(),
      lastTelegramMessageId: params.lastTelegramMessageId ?? null,
      activeCardStatus: params.lastTelegramMessageId ? "active" : "pending_first_card",
    },
  });
  await writeAudit({
    userId: params.userId,
    action: "assistant.pending_action_prompt_created",
    entityType: "agent_action",
    entityId: action?.id ?? undefined,
    details: {
      promptType: params.promptType,
      targetItemId: params.targetItemId ?? null,
      targetReminderId: params.targetReminderId ?? null,
      targetPolicyId: params.targetPolicyId ?? null,
      renderMode: params.renderMode ?? null,
      allowedActions: params.allowedActions ?? [],
      buttonsAttached: params.buttonsAttached ?? false,
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
    await writeAudit({
      userId: params.userId,
      action:
        params.reason === "target_answered" || params.reason?.includes("acknowledged")
          ? "assistant.pending_action_prompt_answered"
          : "assistant.pending_action_prompt_cancelled",
      entityType: "agent_action",
      entityId: action.id,
      details: {
        reason: params.reason ?? "target_answered",
        promptType: action.input?.promptType ?? null,
        targetItemId: action.input?.targetItemId ?? null,
        targetReminderId: action.input?.targetReminderId ?? null,
        targetPolicyId: action.input?.targetPolicyId ?? null,
      },
    }).catch(() => undefined);
  }
  return matched.length;
}

export async function runDuePendingPromptRenags(params: {
  now: Date;
  sender: ReminderTelegramSender;
  limit?: number;
  onlyActionId?: string;
}) {
  const dueActions = await listDuePendingAgentActionsByType({
    actionType: PENDING_PROMPT_RENAG_ACTION,
    now: params.now,
    limit: params.onlyActionId ? 200 : (params.limit ?? 10),
  });
  const actions = params.onlyActionId
    ? dueActions.filter((action) => action.id === params.onlyActionId)
    : dueActions;
  let sent = 0;
  let cancelled = 0;
  let edited = 0;
  let replaced = 0;
  let duplicateActiveSessions = 0;
  const seenTargets = new Set<string>();
  for (const action of actions) {
    if (!action.userId) continue;
    const activeTargetKey = targetKey(action);
    if (activeTargetKey && seenTargets.has(activeTargetKey)) {
      await cancelAction(action, "duplicate_active_renag_session", {
        duplicateActiveSession: true,
      });
      duplicateActiveSessions += 1;
      cancelled += 1;
      continue;
    }
    if (activeTargetKey) seenTargets.add(activeTargetKey);
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
    const reminderId =
      typeof action.input?.targetReminderId === "string" ? action.input.targetReminderId : null;
    if (!reminderId) {
      await cancelAction(action, "missing_target_reminder");
      cancelled += 1;
      continue;
    }
    const resolution = await resolveActionableReminderCard({
      userId: user.id,
      reminderId,
      now: params.now,
    });
    if (resolution.status === "cancel") {
      await cancelAction(action, resolution.reason);
      cancelled += 1;
      continue;
    }
    if (resolution.status === "stale") {
      const message = await params.sender.sendMessage(
        user.telegramUserId.toString(),
        resolution.text,
        withTelegramDeliveryPolicy("status_ack", {
          reply_markup: new InlineKeyboard().text("К плану", "dashboard:refresh"),
        }),
      );
      await auditTelegramDelivery({
        userId: user.id,
        messageKind: "status_ack",
        entityType: "reminder",
        entityId: reminderId,
        targetReminderId: reminderId,
        targetItemId:
          typeof action.input?.targetItemId === "string" ? action.input.targetItemId : null,
        targetPolicyId:
          typeof action.input?.targetPolicyId === "string" ? action.input.targetPolicyId : null,
      });
      await cancelAction(action, resolution.reason, {
        messageId: message.message_id ?? null,
        buttonsAttached: true,
        renderMode: "stale",
      });
      cancelled += 1;
      continue;
    }
    const card = resolution.card;
    const messageOptions = withTelegramDeliveryPolicy("renag_alert", {
      reply_markup: card.keyboard,
    });
    const renderedHash = hashRenderedCard(card.text, messageOptions.reply_markup);
    const previousMessageId = numericOutput(action.output?.lastTelegramMessageId);
    const renagCount = Number(action.output?.renagCount ?? 0) + 1;
    const editOnly = action.output?.stackDeliveryMode === "edit_only";
    if (previousMessageId && (editOnly || typeof params.sender.deleteMessage !== "function")) {
      if (typeof params.sender.editMessageText === "function") {
        try {
          await params.sender.editMessageText(
            user.telegramUserId.toString(),
            previousMessageId,
            card.text,
            messageOptions,
          );
          await updateAgentAction({
            userId: user.id,
            actionId: action.id,
            status: "pending",
            output: {
              ...(action.output ?? {}),
              lastEditedAt: params.now.toISOString(),
              nextRenagAt: new Date(params.now.getTime() + 5 * 60_000).toISOString(),
              renagCount,
              lastRenderedHash: renderedHash,
              lastRenderMode: card.renderMode,
              lastButtonsAttached: card.buttonsAttached,
              activeCardStatus: "active",
            },
          });
          await writeAudit({
            userId: user.id,
            action: "assistant.renag_card_edited",
            entityType: "agent_action",
            entityId: action.id,
            details: renagAuditDetails(action, {
              renagCount,
              messageId: previousMessageId,
              renderMode: card.renderMode,
              buttonsAttached: card.buttonsAttached,
              allowedActions: card.allowedActions,
              renderedHash,
            }),
          }).catch(() => undefined);
          edited += 1;
          continue;
        } catch (error) {
          const editFailureReason = classifyTelegramEditFailure(error);
          if (editFailureReason === "message_not_modified") {
            await updateAgentAction({
              userId: user.id,
              actionId: action.id,
              status: "pending",
              output: {
                ...(action.output ?? {}),
                lastEditNoopAt: params.now.toISOString(),
                nextRenagAt: new Date(params.now.getTime() + 5 * 60_000).toISOString(),
                renagCount,
                lastRenderedHash: renderedHash,
                activeCardStatus: "active",
              },
            });
            await writeAudit({
              userId: user.id,
              action: "assistant.renag_edit_noop_success",
              entityType: "agent_action",
              entityId: action.id,
              details: renagAuditDetails(action, {
                messageId: previousMessageId,
                renagCount,
                renderedHash,
              }),
            }).catch(() => undefined);
            edited += 1;
            continue;
          }
          await writeAudit({
            userId: user.id,
            action: "assistant.renag_card_edit_failed",
            entityType: "agent_action",
            entityId: action.id,
            details: renagAuditDetails(action, {
              messageId: previousMessageId,
              editFailureReason,
            }),
          }).catch(() => undefined);
        }
      }
      await updateAgentAction({
        userId: user.id,
        actionId: action.id,
        status: "pending",
        output: {
          ...(action.output ?? {}),
          lastEditSkippedAt: params.now.toISOString(),
          nextRenagAt: new Date(params.now.getTime() + 5 * 60_000).toISOString(),
          renagCount,
          lastRenderedHash: renderedHash,
          lastRenderMode: card.renderMode,
          lastButtonsAttached: card.buttonsAttached,
          activeCardStatus: "active",
          stackDeliveryMode: "edit_only",
        },
      });
      await writeAudit({
        userId: user.id,
        action: "assistant.renag_duplicate_visible_card_prevented",
        entityType: "agent_action",
        entityId: action.id,
        details: renagAuditDetails(action, {
          renagCount,
          messageId: previousMessageId,
          reason: "delete_or_edit_unavailable",
        }),
      }).catch(() => undefined);
      edited += 1;
      continue;
    }

    const message = await params.sender.sendMessage(
      user.telegramUserId.toString(),
      card.text,
      messageOptions,
    );
    await auditTelegramSendMode({
      userId: user.id,
      targetItemId: action.input?.targetItemId,
      targetPolicyId: action.input?.targetPolicyId,
      targetReminderId: action.input?.targetReminderId,
    });
    await writeAudit({
      userId: user.id,
      action: "assistant.renag_card_sent_loud",
      entityType: "agent_action",
      entityId: action.id,
      details: renagAuditDetails(action, {
        newMessageId: message.message_id ?? null,
        previousMessageId,
        disableNotification: false,
        deliverySoundMode: "loud_reminder",
      }),
    }).catch(() => undefined);

    const supersededMessageIds = [
      ...arrayOutput(action.output?.supersededMessageIds),
      ...(previousMessageId ? [previousMessageId] : []),
    ].filter((messageId, index, values) => values.indexOf(messageId) === index);
    const deletedMessageIds: number[] = [];
    const failedDeleteMessageIds: number[] = [];
    if (previousMessageId && typeof params.sender.deleteMessage === "function") {
      for (const messageId of supersededMessageIds) {
        try {
          await params.sender.deleteMessage(user.telegramUserId.toString(), messageId);
          deletedMessageIds.push(messageId);
          await writeAudit({
            userId: user.id,
            action: "assistant.renag_previous_card_deleted",
            entityType: "agent_action",
            entityId: action.id,
            details: renagAuditDetails(action, {
              newMessageId: message.message_id ?? null,
              deletedMessageId: messageId,
              disableNotification: false,
              deliverySoundMode: "loud_reminder",
            }),
          }).catch(() => undefined);
        } catch (error) {
          failedDeleteMessageIds.push(messageId);
          await writeAudit({
            userId: user.id,
            action: "assistant.renag_previous_card_delete_failed",
            entityType: "agent_action",
            entityId: action.id,
            details: renagAuditDetails(action, {
              newMessageId: message.message_id ?? null,
              deletedMessageId: messageId,
              deleteFailureReason: classifyTelegramDeleteFailure(error),
            }),
          }).catch(() => undefined);
        }
      }
    }

    if (previousMessageId && failedDeleteMessageIds.includes(previousMessageId)) {
      let rolledBackNewCard = false;
      if (message.message_id && typeof params.sender.deleteMessage === "function") {
        try {
          await params.sender.deleteMessage(user.telegramUserId.toString(), message.message_id);
          rolledBackNewCard = true;
        } catch {
          rolledBackNewCard = false;
        }
      }
      if (rolledBackNewCard) {
        await updateAgentAction({
          userId: user.id,
          actionId: action.id,
          status: "pending",
          output: {
            ...(action.output ?? {}),
            nextRenagAt: new Date(params.now.getTime() + 5 * 60_000).toISOString(),
            renagCount,
            activeCardStatus: "active",
            stackDeliveryMode: "edit_only",
            lastDeleteFailedAt: params.now.toISOString(),
          },
        });
        await writeAudit({
          userId: user.id,
          action: "assistant.renag_duplicate_visible_card_prevented",
          entityType: "agent_action",
          entityId: action.id,
          details: renagAuditDetails(action, {
            keptMessageId: previousMessageId,
            rolledBackMessageId: message.message_id ?? null,
            reason: "previous_card_delete_failed",
          }),
        }).catch(() => undefined);
        sent += 1;
        edited += 1;
        continue;
      }
    }
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
        lastRenderedHash: renderedHash,
        lastRenderMode: card.renderMode,
        lastButtonsAttached: card.buttonsAttached,
        activeCardStatus: "active",
        supersededAt: null,
        supersededOldCards: failedDeleteMessageIds.length > 0,
        supersededMessageIds: failedDeleteMessageIds,
        deletedMessageIds: [...arrayOutput(action.output?.deletedMessageIds), ...deletedMessageIds],
        stackDeliveryMode: failedDeleteMessageIds.length ? "edit_only" : "send_then_delete",
      },
    });
    await writeAudit({
      userId: user.id,
      action: previousMessageId
        ? "assistant.renag_previous_card_deleted"
        : "assistant.pending_action_prompt_renag_sent",
      entityType: "agent_action",
      entityId: action.id,
      details: renagAuditDetails(action, {
        renagCount,
        messageId: message.message_id ?? null,
        supersededMessageId: previousMessageId ?? null,
        deletedMessageIds,
        failedDeleteMessageIds,
        renderMode: card.renderMode,
        buttonsAttached: card.buttonsAttached,
        allowedActions: card.allowedActions,
        renderedHash,
      }),
    }).catch(() => undefined);
    sent += 1;
    if (previousMessageId) replaced += 1;
  }
  return { checked: actions.length, sent, cancelled, edited, replaced, duplicateActiveSessions };
}

async function cancelAction(
  action: Awaited<ReturnType<typeof listDuePendingAgentActionsByType>>[number],
  reason: string,
  details?: Record<string, unknown>,
) {
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
  await writeAudit({
    userId: action.userId,
    action:
      reason === "expired"
        ? "assistant.pending_action_prompt_expired"
        : "assistant.pending_action_prompt_cancelled",
    entityType: "agent_action",
    entityId: action.id,
    details: {
      reason,
      promptType: action.input?.promptType ?? null,
      targetItemId: action.input?.targetItemId ?? null,
      targetReminderId: action.input?.targetReminderId ?? null,
      targetPolicyId: action.input?.targetPolicyId ?? null,
      renderMode: action.input?.renderMode ?? null,
      buttonsAttached: false,
      cancelReason: reason,
      ...(details ?? {}),
    },
  }).catch(() => undefined);
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function targetKey(action: Awaited<ReturnType<typeof listDuePendingAgentActionsByType>>[number]) {
  return targetGroupKey(action.userId ?? "", action.input ?? {});
}

export function targetGroupKey(
  userId: string,
  target: {
    targetItemId?: unknown;
    targetReminderId?: unknown;
    targetPolicyId?: unknown;
  },
) {
  const itemId = typeof target.targetItemId === "string" ? target.targetItemId : null;
  const policyId = typeof target.targetPolicyId === "string" ? target.targetPolicyId : null;
  const reminderId = typeof target.targetReminderId === "string" ? target.targetReminderId : null;
  if (policyId) return `${userId}:policy:${policyId}:${itemId ?? "none"}`;
  if (itemId) return `${userId}:item:${itemId}`;
  if (reminderId) return `${userId}:reminder:${reminderId}`;
  return null;
}

function numericOutput(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function arrayOutput(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => Number.isFinite(Number(entry))).map(Number)
    : [];
}

function hashRenderedCard(text: string, replyMarkup: unknown) {
  return createHash("sha256")
    .update(JSON.stringify({ text, replyMarkup }))
    .digest("hex")
    .slice(0, 24);
}

function classifyTelegramEditFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/message is not modified/i.test(message)) return "message_not_modified";
  if (/message to edit not found|message can't be edited|too old|inaccessible/i.test(message)) {
    return "message_not_editable";
  }
  return "edit_failed";
}

function classifyTelegramDeleteFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/message to delete not found|message not found/i.test(message)) return "message_not_found";
  if (/message can't be deleted|too old|inaccessible/i.test(message)) {
    return "message_not_deletable";
  }
  return "delete_failed";
}

function renagAuditDetails(
  action: Awaited<ReturnType<typeof listDuePendingAgentActionsByType>>[number],
  details: Record<string, unknown>,
) {
  return {
    promptType: action.input?.promptType ?? null,
    targetItemId: action.input?.targetItemId ?? null,
    targetPolicyId: action.input?.targetPolicyId ?? null,
    targetReminderId: action.input?.targetReminderId ?? null,
    ...details,
  };
}

async function auditTelegramSendMode(params: {
  userId: string;
  targetItemId?: unknown;
  targetPolicyId?: unknown;
  targetReminderId?: unknown;
}) {
  await auditTelegramDelivery({
    userId: params.userId,
    messageKind: "renag_alert",
    entityType: "reminder",
    entityId: typeof params.targetReminderId === "string" ? params.targetReminderId : null,
    targetItemId: typeof params.targetItemId === "string" ? params.targetItemId : null,
    targetPolicyId: typeof params.targetPolicyId === "string" ? params.targetPolicyId : null,
    targetReminderId: typeof params.targetReminderId === "string" ? params.targetReminderId : null,
  });
}
