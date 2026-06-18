import { randomUUID } from "node:crypto";

import { writeAudit, writeAuditOnceByKey } from "@/db/queries/audit";
import {
  cancelPlannerItemWithMetadata,
  createManualPlannerItem,
  getPlannerItemById,
} from "@/db/queries/items";
import {
  createReminderPolicyIfMissing,
  listReminderPoliciesForItem,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import {
  createReminderIfMissing,
  getReminderByIdForUser,
  snoozeReminder,
} from "@/db/queries/reminders";
import type { PlannerItem, Reminder, ReminderPolicy } from "@/db/schema";
import {
  cancelPendingPromptRenagsForTarget,
  recordPendingPromptRenag,
  runDuePendingPromptRenags,
} from "@/services/pendingPromptRenag";
import {
  repairCarLocationReminderItem,
} from "@/services/v2240ProductionRepair";
import { renderActionableReminderCard } from "@/telegram/reminderCard";

export async function runV2240PinnedRepairSmoke(params: {
  userId: string;
  timezone: string;
}) {
  const smokeRunId = randomUUID();
  const now = new Date();
  const item = await createManualPlannerItem({
    userId: params.userId,
    kind: "task",
    title: `Напоминание об оставленной машине на тестовой парковке ${smokeRunId.slice(0, 8)}`,
    timezone: params.timezone,
    dueAt: new Date(now.getTime() + 60 * 60_000),
    category: "reminder",
    metadata: { isTest: true, smokeRunId },
  });
  const policy = await createReminderPolicyIfMissing({
    userId: params.userId,
    itemId: item.id,
    title: item.title,
    category: "car",
    policyType: "one_time",
    timezone: params.timezone,
    nextFireAt: item.dueAt,
    idempotencyKey: `v2240-pinned-repair:${smokeRunId}`,
    metadata: { isTest: true, smokeRunId },
  });
  await createReminderIfMissing({
    userId: params.userId,
    plannerItemId: item.id,
    policyId: policy.id,
    type: "custom",
    scheduledAt: item.dueAt!,
    idempotencyKey: `v2240-pinned-repair-reminder:${smokeRunId}`,
    payload: { isTest: true, smokeRunId },
  });

  const repaired = await repairCarLocationReminderItem({
    userId: params.userId,
    candidate: item,
    existingPinnedCarNote: null,
    now,
  });
  const [updatedItem, policies] = await Promise.all([
    getPlannerItemById(params.userId, item.id),
    listReminderPoliciesForItem(params.userId, item.id, 20),
  ]);
  const ok = Boolean(
    updatedItem &&
      updatedItem.kind === "note" &&
      updatedItem.metadata?.pinnedContext === true &&
      updatedItem.metadata?.pinnedCategory === "car_location" &&
      !updatedItem.startAt &&
      !updatedItem.endAt &&
      !updatedItem.dueAt &&
      policies.every((entry) => entry.status === "cancelled"),
  );
  await cancelPlannerItemWithMetadata({
    userId: params.userId,
    itemId: item.id,
    metadata: { archivedBy: "v2240_pinned_repair_smoke", smokeRunId },
  });
  const result = {
    ok,
    smokeRunId,
    itemId: item.id,
    converted: repaired.converted,
    activePolicyCount: policies.filter((entry) => entry.status === "active").length,
    calendarObjectsChanged: 0,
  };
  await writeSmokeAudit(params.userId, "assistant.v2240_pinned_repair_smoke", item.id, result);
  return result;
}

export async function runV2240ActionableRenagSmoke(params: {
  userId: string;
  timezone: string;
}) {
  const smokeRunId = randomUUID();
  const now = new Date();
  const item = await createManualPlannerItem({
    userId: params.userId,
    kind: "task",
    title: `V2.24 actionable re-nag smoke ${smokeRunId.slice(0, 8)}`,
    timezone: params.timezone,
    dueAt: new Date(now.getTime() + 8 * 60 * 60_000),
    category: "task",
    metadata: { isTest: true, smokeRunId, untilDone: true },
  });
  const policy = await createReminderPolicyIfMissing({
    userId: params.userId,
    itemId: item.id,
    title: item.title,
    category: "task",
    policyType: "nag_until_ack",
    timezone: params.timezone,
    startsAt: new Date(now.getTime() - 5 * 60_000),
    endsAt: item.dueAt,
    nextFireAt: new Date(now.getTime() - 60_000),
    intervalMinutes: 60,
    requireAck: true,
    onWindowEnd: "move_to_overdue_or_review",
    idempotencyKey: `v2240-actionable-renag:${smokeRunId}`,
    metadata: { isTest: true, smokeRunId, untilDone: true, stopCondition: "until_done" },
  });
  const reminder = await createReminderIfMissing({
    userId: params.userId,
    plannerItemId: item.id,
    policyId: policy.id,
    type: "until_ack",
    scheduledAt: new Date(now.getTime() - 60_000),
    idempotencyKey: `v2240-actionable-renag-reminder:${smokeRunId}`,
    repeatUntilAck: true,
    purpose: "reminder",
    menuType: "reminder",
    payload: { isTest: true, smokeRunId },
  });
  if (!reminder) throw new Error("v2240_actionable_reminder_create_failed");
  const renagAction = await recordPendingPromptRenag({
    userId: params.userId,
    promptType: "task_until_done",
    text: "legacy text must not be resent",
    targetItemId: item.id,
    targetPolicyId: policy.id,
    targetReminderId: reminder.id,
    renderMode: "task_until_done",
    allowedActions: ["ack", "snooze_30"],
    buttonsAttached: true,
    now: new Date(now.getTime() - 6 * 60_000),
  });
  if (!renagAction) throw new Error("v2240_renag_action_create_failed");
  const sentCards: Array<{ text: string; options?: Record<string, unknown> }> = [];
  const firstRun = await runDuePendingPromptRenags({
    now,
    onlyActionId: renagAction.id,
    sender: {
      async sendMessage(_chatId, text, options) {
        sentCards.push({ text, options });
        return { message_id: 2240 };
      },
    },
  });
  const keyboardJson = JSON.stringify(sentCards[0]?.options?.reply_markup ?? {});
  const snoozed = await snoozeReminder({
    userId: params.userId,
    reminderId: reminder.id,
    minutes: 30,
  });
  await cancelPendingPromptRenagsForTarget({
    userId: params.userId,
    targetItemId: item.id,
    targetPolicyId: policy.id,
    targetReminderId: reminder.id,
    reason: "v2240_smoke_snoozed",
  });
  const secondRun = await runDuePendingPromptRenags({
    now: new Date(now.getTime() + 7 * 60_000),
    onlyActionId: renagAction.id,
    sender: {
      async sendMessage() {
        throw new Error("renag_must_not_send_after_snooze");
      },
    },
  });
  const snoozeRow = snoozed?.id
    ? await getReminderByIdForUser({ userId: params.userId, reminderId: snoozed.id })
    : null;
  await updateReminderPolicy({
    userId: params.userId,
    policyId: policy.id,
    status: "cancelled",
    nextFireAt: null,
  });
  await cancelPlannerItemWithMetadata({
    userId: params.userId,
    itemId: item.id,
    metadata: { archivedBy: "v2240_actionable_renag_smoke", smokeRunId },
  });
  const result = {
    ok:
      firstRun.sent === 1 &&
      keyboardJson.includes(`reminder:ack:${reminder.id}`) &&
      keyboardJson.includes(`reminder:snooze:${reminder.id}:30`) &&
      Boolean(snoozeRow) &&
      secondRun.sent === 0,
    smokeRunId,
    firstRenagSent: firstRun.sent,
    buttonsAttached:
      keyboardJson.includes("reminder:ack:") && keyboardJson.includes("reminder:snooze:"),
    snoozeReminderCreated: Boolean(snoozeRow),
    postSnoozeRenagSent: secondRun.sent,
  };
  await writeSmokeAudit(params.userId, "assistant.v2240_actionable_renag_smoke", item.id, result);
  return result;
}

export async function runV2240CarryoverCardSmoke(params: { timezone: string }) {
  const now = new Date();
  const item = smokeItem(params.timezone, {
    dueAt: new Date(now.getTime() - 24 * 60 * 60_000),
    metadata: { untilDone: true, untilDoneCarryover: true },
  });
  const policy = smokePolicy(params.timezone, item.id, {
    endsAt: new Date(now.getTime() + 8 * 60 * 60_000),
    metadata: { untilDone: true, untilDoneCarryover: true, stopCondition: "until_done" },
  });
  const card = renderActionableReminderCard({
    reminder: smokeReminder(item.id, policy.id, now),
    item,
    policy,
    now,
  });
  return {
    ok:
      card.text.includes("Не закрыто со вчера. Продолжаю сегодня до") &&
      card.buttonsAttached,
    renderMode: card.renderMode,
    buttonsAttached: card.buttonsAttached,
    hasCarryoverCopy: card.text.includes("Не закрыто со вчера"),
  };
}

export async function runV2240MonthlyCardSmoke(params: { timezone: string }) {
  const now = new Date();
  const item = smokeItem(params.timezone, {
    kind: "recurring_task",
    title: "V2.24 monthly card smoke",
  });
  const policy = smokePolicy(params.timezone, item.id, {
    policyType: "recurring",
    recurrenceRule: "monthly_days:15,16,17,18,19@12:00",
    startsAt: null,
    endsAt: null,
    intervalMinutes: null,
  });
  const card = renderActionableReminderCard({
    reminder: smokeReminder(item.id, policy.id, now),
    item,
    policy,
    now,
  });
  return {
    ok:
      card.renderMode === "monthly_occurrence" &&
      card.text.includes("Правило:") &&
      !card.text.includes("без времени") &&
      card.buttonsAttached,
    renderMode: card.renderMode,
    buttonsAttached: card.buttonsAttached,
    containsWithoutTime: card.text.includes("без времени"),
  };
}

export async function runV2240MonthlyAuditThrottleSmoke(params: { userId: string }) {
  const auditKey = `v2240-smoke:${randomUUID()}`;
  const first = await writeAuditOnceByKey({
    userId: params.userId,
    action: "assistant.monthly_day_range_occurrence_checked",
    entityType: "reminder_policy",
    auditKey,
    details: { smoke: true },
  });
  const second = await writeAuditOnceByKey({
    userId: params.userId,
    action: "assistant.monthly_day_range_occurrence_checked",
    entityType: "reminder_policy",
    auditKey,
    details: { smoke: true },
  });
  return { ok: first === true && second === false, firstWritten: first, secondWritten: second };
}

async function writeSmokeAudit(
  userId: string,
  action: string,
  entityId: string,
  details: Record<string, unknown>,
) {
  await writeAudit({
    userId,
    action,
    entityType: "planner_item",
    entityId,
    details,
  }).catch(() => undefined);
}

function smokeItem(timezone: string, overrides: Partial<PlannerItem> = {}): PlannerItem {
  const now = new Date();
  return {
    id: randomUUID(),
    userId: randomUUID(),
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "V2.24 smoke",
    description: null,
    location: null,
    timezone,
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "task",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function smokePolicy(
  timezone: string,
  itemId: string,
  overrides: Partial<ReminderPolicy> = {},
): ReminderPolicy {
  const now = new Date();
  return {
    id: randomUUID(),
    userId: randomUUID(),
    itemId,
    title: "V2.24 smoke",
    category: "task",
    policyType: "nag_until_ack",
    status: "active",
    timezone,
    startsAt: now,
    endsAt: new Date(now.getTime() + 8 * 60 * 60_000),
    nextFireAt: now,
    recurrenceRule: null,
    intervalMinutes: 60,
    requireAck: true,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "move_to_overdue_or_review",
    snoozedUntil: null,
    snoozeScope: null,
    quietHours: null,
    escalationPolicy: null,
    metadata: { untilDone: true, stopCondition: "until_done" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function smokeReminder(itemId: string, policyId: string, now: Date): Reminder {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    plannerItemId: itemId,
    type: "until_ack",
    idempotencyKey: randomUUID(),
    scheduledAt: now,
    status: "sent",
    claimedAt: now,
    sentAt: now,
    telegramMessageId: null,
    attemptCount: 1,
    lastError: null,
    repeatUntilAck: true,
    ackedAt: null,
    parentReminderId: null,
    recurrenceKey: null,
    policyId,
    purpose: "reminder",
    menuType: "reminder",
    autoDeleteAfterResponse: true,
    supersededByMessageId: null,
    payload: {},
    createdAt: now,
    updatedAt: now,
  };
}
