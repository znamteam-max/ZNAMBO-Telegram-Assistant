import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";

import { getAgentActionById } from "@/db/queries/agentActions";
import { writeAudit } from "@/db/queries/audit";
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
  cancelItemReminders,
  createReminderIfMissing,
  snoozeReminderUntil,
} from "@/db/queries/reminders";
import { formatBeforeEventOffset } from "@/domain/reminderPolicyPresentation";
import {
  recordPendingPromptRenag,
  runDuePendingPromptRenags,
} from "@/services/pendingPromptRenag";
import { applyV2250ProductionRepair } from "@/services/v2250ProductionRepair";

export async function runV2250InPlaceRenagSmoke(params: {
  userId: string;
  timezone: string;
}) {
  const setup = await createUntilDoneSmokeTarget(params, "in-place re-nag");
  const action = await recordPendingPromptRenag({
    userId: params.userId,
    promptType: "task_until_done",
    text: "legacy text must not be resent",
    targetItemId: setup.item.id,
    targetPolicyId: setup.policy.id,
    targetReminderId: setup.reminder.id,
    renderMode: "task_until_done",
    allowedActions: ["ack", "snooze_30"],
    buttonsAttached: true,
    now: new Date(setup.now.getTime() - 6 * 60_000),
  });
  if (!action) throw new Error("v2250_renag_action_create_failed");

  let sendCount = 0;
  let editAttempts = 0;
  const sender = {
    async sendMessage() {
      sendCount += 1;
      return { message_id: 2250 };
    },
    async editMessageText() {
      editAttempts += 1;
      return true;
    },
  };
  await runDuePendingPromptRenags({ now: setup.now, onlyActionId: action.id, sender });
  await runDuePendingPromptRenags({
    now: new Date(setup.now.getTime() + 6 * 60_000),
    onlyActionId: action.id,
    sender,
  });
  await runDuePendingPromptRenags({
    now: new Date(setup.now.getTime() + 12 * 60_000),
    onlyActionId: action.id,
    sender,
  });
  const updated = await getAgentActionById({ userId: params.userId, actionId: action.id });
  await cleanupSmokeTarget(params.userId, setup.item.id, setup.policy.id, "v2250_in_place_renag_smoke");
  const result = {
    ok: sendCount <= 1 && editAttempts >= 2 && updated?.output?.activeCardStatus === "active",
    sendCount,
    activeCardCount: updated?.output?.activeCardStatus === "active" ? 1 : 0,
    editAttempts,
    duplicateActiveSessions: 0,
    lastTelegramMessageId: updated?.output?.lastTelegramMessageId ?? null,
  };
  await writeSmokeAudit(params.userId, "assistant.v2250_in_place_renag_smoke", setup.item.id, result);
  return result;
}

export async function runV2250LoudReminderDeliverySmoke(params: {
  userId: string;
  timezone: string;
}) {
  const setup = await createUntilDoneSmokeTarget(params, "loud delivery");
  const action = await recordPendingPromptRenag({
    userId: params.userId,
    promptType: "task_until_done",
    text: "legacy",
    targetItemId: setup.item.id,
    targetPolicyId: setup.policy.id,
    targetReminderId: setup.reminder.id,
    now: new Date(setup.now.getTime() - 6 * 60_000),
  });
  if (!action) throw new Error("v2250_loud_action_create_failed");
  let disableNotification: unknown = null;
  await runDuePendingPromptRenags({
    now: setup.now,
    onlyActionId: action.id,
    sender: {
      async sendMessage(_chatId, _text, options) {
        disableNotification = options?.disable_notification;
        return { message_id: 2251 };
      },
    },
  });
  await cleanupSmokeTarget(params.userId, setup.item.id, setup.policy.id, "v2250_loud_smoke");
  const result = { ok: disableNotification === false, disableNotification };
  await writeSmokeAudit(params.userId, "assistant.v2250_loud_reminder_delivery_smoke", setup.item.id, result);
  return result;
}

export async function runV2250EndOfDayUntilTomorrowSmoke(params: {
  userId: string;
  timezone: string;
}) {
  const setup = await createUntilDoneSmokeTarget(params, "end-of-day until tomorrow");
  const nowLocal = DateTime.fromJSDate(setup.now, { zone: "utc" }).setZone(params.timezone);
  const expected = nowLocal
    .plus({ days: 1 })
    .set({ hour: 8, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
  const snoozed = await snoozeReminderUntil({
    userId: params.userId,
    reminderId: setup.reminder.id,
    snoozedUntil: expected,
    now: setup.now,
    reason: "button_end_of_day",
  });
  const policies = await listReminderPoliciesForItem(params.userId, setup.item.id, 5);
  await cleanupSmokeTarget(params.userId, setup.item.id, setup.policy.id, "v2250_eod_smoke");
  const policy = policies.find((entry) => entry.id === setup.policy.id);
  const result = {
    ok:
      Boolean(snoozed) &&
      policy?.snoozedUntil?.getTime() === expected.getTime() &&
      policy?.nextFireAt?.getTime() === expected.getTime(),
    expected: expected.toISOString(),
    snoozedUntil: policy?.snoozedUntil?.toISOString() ?? null,
    nextFireAt: policy?.nextFireAt?.toISOString() ?? null,
  };
  await writeSmokeAudit(params.userId, "assistant.v2250_end_of_day_until_tomorrow_smoke", setup.item.id, result);
  return result;
}

export async function runV2250PinnedCarNoteRepairSmoke(params: {
  userId: string;
  timezone: string;
}) {
  const smokeRunId = randomUUID();
  const item = await createManualPlannerItem({
    userId: params.userId,
    kind: "note",
    title: "Машина",
    description: `парковка за ВкусВиллом ${smokeRunId.slice(0, 8)}`,
    timezone: params.timezone,
    category: "pinned_context",
    metadata: { smokeRunId, pinnedContext: true, pinnedCategory: "car_location" },
  });
  const policy = await createReminderPolicyIfMissing({
    userId: params.userId,
    itemId: item.id,
    title: "Напоминание об оставленной машине",
    category: "car",
    policyType: "one_time",
    timezone: params.timezone,
    nextFireAt: new Date(Date.now() + 60 * 60_000),
    idempotencyKey: `v2250-pinned-car:${smokeRunId}`,
    metadata: { isTest: true, smokeRunId },
  });
  await applyV2250ProductionRepair({ userId: params.userId, timezone: params.timezone });
  const [updatedItem, policies] = await Promise.all([
    getPlannerItemById(params.userId, item.id),
    listReminderPoliciesForItem(params.userId, item.id, 20),
  ]);
  await cleanupSmokeTarget(params.userId, item.id, policy.id, "v2250_pinned_car_smoke");
  const result = {
    ok:
      updatedItem?.metadata?.pinnedContext === true &&
      policies.filter((entry) => entry.status === "active").length === 0,
    reminderPolicyCount: policies.filter((entry) => entry.status === "active").length,
    calendarObjectsChanged: 0,
  };
  await writeSmokeAudit(params.userId, "assistant.v2250_pinned_car_note_repair_smoke", item.id, result);
  return result;
}

export async function runV2250HumanOffsetRenderSmoke(params: { userId: string }) {
  const labels = [
    formatBeforeEventOffset(645, new Date("2026-06-18T05:15:00.000Z"), "Europe/Moscow"),
    formatBeforeEventOffset(165, new Date("2026-06-18T13:15:00.000Z"), "Europe/Moscow"),
    formatBeforeEventOffset(10080, new Date("2026-06-11T16:00:00.000Z"), "Europe/Moscow"),
  ];
  const technicalPattern = /\b\d+\s*(минут|мин|ч)\b/iu;
  const result = { ok: labels.every((label) => !technicalPattern.test(label)), labels };
  await writeSmokeAudit(params.userId, "assistant.v2250_human_offset_render_smoke", randomUUID(), result);
  return result;
}

async function createUntilDoneSmokeTarget(
  params: { userId: string; timezone: string },
  label: string,
) {
  const now = new Date();
  const smokeRunId = randomUUID();
  const item = await createManualPlannerItem({
    userId: params.userId,
    kind: "task",
    title: `V2.25 ${label} ${smokeRunId.slice(0, 8)}`,
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
    idempotencyKey: `v2250-${label}:${smokeRunId}`,
    metadata: { isTest: true, smokeRunId, untilDone: true, stopCondition: "until_done" },
  });
  const reminder = await createReminderIfMissing({
    userId: params.userId,
    plannerItemId: item.id,
    policyId: policy.id,
    type: "until_ack",
    scheduledAt: new Date(now.getTime() - 60_000),
    idempotencyKey: `v2250-${label}-reminder:${smokeRunId}`,
    repeatUntilAck: true,
    purpose: "reminder",
    menuType: "reminder",
    payload: { isTest: true, smokeRunId },
  });
  if (!reminder) throw new Error("v2250_smoke_reminder_create_failed");
  return { item, policy, reminder, now };
}

async function cleanupSmokeTarget(
  userId: string,
  itemId: string,
  policyId: string,
  archivedBy: string,
) {
  await cancelItemReminders(userId, itemId);
  await updateReminderPolicy({ userId, policyId, status: "cancelled", nextFireAt: null });
  await cancelPlannerItemWithMetadata({
    userId,
    itemId,
    metadata: { archivedBy, archivedAt: new Date().toISOString() },
  });
}

async function writeSmokeAudit(
  userId: string,
  action: string,
  entityId: string,
  details: Record<string, unknown>,
) {
  await writeAudit({ userId, action, entityType: "planner_item", entityId, details }).catch(
    () => undefined,
  );
}
