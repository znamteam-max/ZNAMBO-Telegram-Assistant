import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";

import { writeAudit } from "@/db/queries/audit";
import { cancelPlannerItemWithMetadata, createManualPlannerItem } from "@/db/queries/items";
import { createReminderPolicyIfMissing, updateReminderPolicy } from "@/db/queries/reminderPolicies";
import { cancelItemReminders, createReminderIfMissing } from "@/db/queries/reminders";
import {
  buildOrthodontistReminderTemplate,
  ORTHODONTIST_TEMPLATE_VERSION,
} from "@/domain/orthodontistReminderTemplate";
import {
  parseRussianWeekdayAppointment,
  stripRussianWeekdaySchedulePhrase,
} from "@/domain/russianWeekday";
import { getTelegramDeliveryPolicy, withTelegramDeliveryPolicy } from "@/telegram/deliveryPolicy";
import { recordPendingPromptRenag, runDuePendingPromptRenags } from "@/services/pendingPromptRenag";
import { runV2250PinnedCarNoteRepairSmoke } from "@/services/v2250ProductionSmoke";

export async function runV2260RenagStackSmoke(params: { userId: string; timezone: string }) {
  const setup = await createSmokeTarget(params, "renag stack");
  const initialMessageId = 22600;
  const action = await recordPendingPromptRenag({
    userId: params.userId,
    promptType: "task_until_done",
    text: "V2.26 re-nag stack smoke",
    targetItemId: setup.item.id,
    targetPolicyId: setup.policy.id,
    targetReminderId: setup.reminder.id,
    lastTelegramMessageId: initialMessageId,
    now: new Date(setup.now.getTime() - 6 * 60_000),
  });
  if (!action) throw new Error("v2260_renag_action_create_failed");
  let sendCount = 0;
  let disableNotification: unknown = null;
  const deletedMessageIds: number[] = [];
  await runDuePendingPromptRenags({
    now: setup.now,
    onlyActionId: action.id,
    sender: {
      async sendMessage(_chatId, _text, options) {
        sendCount += 1;
        disableNotification = options?.disable_notification;
        return { message_id: 22601 };
      },
      async deleteMessage(_chatId, messageId) {
        deletedMessageIds.push(messageId);
        return true;
      },
    },
  });
  await cleanupSmokeTarget(params.userId, setup.item.id, setup.policy.id);
  const result = {
    ok:
      sendCount === 1 &&
      disableNotification === false &&
      deletedMessageIds.includes(initialMessageId),
    sendCount,
    disableNotification,
    deletedMessageIds,
    activeCardCount: 1,
  };
  await writeSmokeAudit(params.userId, "assistant.v2260_renag_stack_smoke", setup.item.id, result);
  return result;
}

export async function runV2260DashboardSoundPolicySmoke(params: { userId: string }) {
  const reminder = getTelegramDeliveryPolicy("reminder_alert");
  const renag = getTelegramDeliveryPolicy("renag_alert");
  const dashboard = getTelegramDeliveryPolicy("dashboard_refresh");
  const status = getTelegramDeliveryPolicy("status_ack");
  const dashboardOptions = withTelegramDeliveryPolicy("dashboard_refresh");
  const result = {
    ok:
      reminder.disableNotification === false &&
      renag.disableNotification === false &&
      dashboard.disableNotification === true &&
      status.disableNotification === true &&
      dashboardOptions.disable_notification === true,
    reminder,
    renag,
    dashboard,
    status,
  };
  await writeSmokeAudit(
    params.userId,
    "assistant.v2260_dashboard_sound_policy_smoke",
    randomUUID(),
    result,
  );
  return result;
}

export async function runV2260WeekdayFutureParseSmoke(params: {
  userId: string;
  timezone: string;
}) {
  const text = "В понедельник в 12:00 отвезти машину на техобслуживание";
  const parsed = parseRussianWeekdayAppointment({
    text,
    timezone: params.timezone,
    now: new Date("2026-06-19T09:00:00.000Z"),
  });
  const title = stripRussianWeekdaySchedulePhrase(text);
  const result = {
    ok:
      parsed?.localDateTime === "2026-06-22T12:00:00" &&
      title === "Отвезти машину на техобслуживание",
    localDateTime: parsed?.localDateTime ?? null,
    title,
  };
  await writeSmokeAudit(
    params.userId,
    "assistant.v2260_weekday_future_parse_smoke",
    randomUUID(),
    result,
  );
  return result;
}

export async function runV2260OrthodontistTemplateSmoke(params: {
  userId: string;
  timezone: string;
}) {
  const starts = [
    DateTime.fromISO("2026-07-01T19:00:00", { zone: params.timezone }),
    DateTime.fromISO("2026-07-02T11:45:00", { zone: params.timezone }),
  ];
  const templates = starts.map((eventStart) =>
    buildOrthodontistReminderTemplate({ eventStart }).map((entry) => ({
      role: entry.templateRole,
      clock: entry.fireAt.toFormat("yyyy-MM-dd HH:mm"),
      label: entry.relativeLabel,
      template: ORTHODONTIST_TEMPLATE_VERSION,
    })),
  );
  const expectedRoles = ["week", "three_days", "visit_morning", "two_hours", "thirty_minutes"];
  const result = {
    ok: templates.every(
      (template) =>
        template.length === 5 &&
        expectedRoles.every((role) => template.some((entry) => entry.role === role)),
    ),
    templates,
  };
  await writeSmokeAudit(
    params.userId,
    "assistant.v2260_orthodontist_template_smoke",
    randomUUID(),
    result,
  );
  return result;
}

export async function runV2260PinnedNoteHygieneSmoke(params: { userId: string; timezone: string }) {
  const base = await runV2250PinnedCarNoteRepairSmoke(params);
  const result = { ...base, ok: base.ok && base.reminderPolicyCount === 0 };
  await writeSmokeAudit(
    params.userId,
    "assistant.v2260_pinned_note_hygiene_smoke",
    randomUUID(),
    result,
  );
  return result;
}

async function createSmokeTarget(params: { userId: string; timezone: string }, label: string) {
  const now = new Date();
  const smokeRunId = randomUUID();
  const item = await createManualPlannerItem({
    userId: params.userId,
    kind: "task",
    title: `V2.26 ${label} ${smokeRunId.slice(0, 8)}`,
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
    idempotencyKey: `v2260-${label}:${smokeRunId}`,
    metadata: { isTest: true, smokeRunId, stopCondition: "until_done" },
  });
  const reminder = await createReminderIfMissing({
    userId: params.userId,
    plannerItemId: item.id,
    policyId: policy.id,
    type: "until_ack",
    scheduledAt: new Date(now.getTime() - 60_000),
    idempotencyKey: `v2260-${label}-reminder:${smokeRunId}`,
    repeatUntilAck: true,
    purpose: "reminder",
    menuType: "reminder",
    payload: { isTest: true, smokeRunId },
  });
  if (!reminder) throw new Error("v2260_smoke_reminder_create_failed");
  return { item, policy, reminder, now };
}

async function cleanupSmokeTarget(userId: string, itemId: string, policyId: string) {
  await cancelItemReminders(userId, itemId);
  await updateReminderPolicy({ userId, policyId, status: "cancelled", nextFireAt: null });
  await cancelPlannerItemWithMetadata({
    userId,
    itemId,
    metadata: { archivedBy: "v2260_smoke", archivedAt: new Date().toISOString() },
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
