import { DateTime } from "luxon";

import { listPendingAgentActionsByTypes, updateAgentAction } from "@/db/queries/agentActions";
import { listRecentAuditLogs } from "@/db/queries/audit";
import { listManageableItems, updatePlannerItemDetails } from "@/db/queries/items";
import {
  createReminderPolicyIfMissing,
  listReminderPoliciesForUser,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelPendingRemindersForPolicy, createReminderIfMissing } from "@/db/queries/reminders";
import { getUserById } from "@/db/queries/users";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";
import { hasDeadlineIntent } from "@/domain/deadlineSemantics";
import {
  buildOrthodontistReminderTemplate,
  isOrthodontistVisitTitle,
  ORTHODONTIST_TEMPLATE_VERSION,
} from "@/domain/orthodontistReminderTemplate";
import {
  parseRussianWeekdayAppointment,
  stripRussianWeekdaySchedulePhrase,
} from "@/domain/russianWeekday";
import { getBot } from "@/bot/createBot";
import { PENDING_PROMPT_RENAG_ACTION, targetGroupKey } from "@/services/pendingPromptRenag";
import {
  applyV2250ProductionRepair,
  previewV2250ProductionRepair,
} from "@/services/v2250ProductionRepair";

type WeekdayRepairCandidate = {
  item: PlannerItem;
  title: string;
  startAt: Date;
};

type OrthodontistCandidate = {
  item: PlannerItem;
  policies: ReminderPolicy[];
};

export async function previewV2260ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const [base, candidates] = await Promise.all([
    previewV2250ProductionRepair(params),
    collectV2260Candidates(params),
  ]);
  return {
    duplicateVisibleRenagCards: candidates.renagCardsToDelete.length,
    renagCardsToDelete: candidates.renagCardsToDelete.length,
    misparsedWeekdayItems: candidates.weekdayItems.length,
    orthodontistTemplateMismatches: candidates.orthodontistItems.length,
    pinnedNotesWithReminderPolicies: base.carReminderPoliciesToConvert,
    dashboardsSentLoudAfterReminder: candidates.loudDashboardAudits,
    calendarObjectsToChange: 0 as const,
    safeToApply: true as const,
  };
}

export async function applyV2260ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const candidates = await collectV2260Candidates({ ...params, now });
  const base = await applyV2250ProductionRepair({ ...params, now });
  const user = await getUserById(params.userId);
  const deletedOldRenagCards: number[] = [];
  const failedOldRenagCards: number[] = [];

  if (user) {
    const api = getBot().api;
    for (const messageId of [
      ...new Set(candidates.renagCardsToDelete.map((entry) => entry.messageId)),
    ]) {
      try {
        await api.deleteMessage(user.telegramUserId.toString(), messageId);
        deletedOldRenagCards.push(messageId);
      } catch {
        failedOldRenagCards.push(messageId);
      }
    }
  }

  for (const action of candidates.pendingActions) {
    const deletedForAction = candidates.renagCardsToDelete
      .filter((entry) => entry.actionId === action.id)
      .map((entry) => entry.messageId)
      .filter((messageId) => deletedOldRenagCards.includes(messageId));
    const failedForAction = candidates.renagCardsToDelete
      .filter((entry) => entry.actionId === action.id)
      .map((entry) => entry.messageId)
      .filter((messageId) => failedOldRenagCards.includes(messageId));
    if (!deletedForAction.length && !failedForAction.length) continue;
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: action.status,
      output: {
        ...(action.output ?? {}),
        supersededMessageIds: failedForAction,
        deletedMessageIds: [...numberArray(action.output?.deletedMessageIds), ...deletedForAction],
        stackDeliveryMode: failedForAction.length ? "edit_only" : "send_then_delete",
        repairedBy: "admin_repair_v2260",
        repairedAt: now.toISOString(),
      },
    });
  }

  for (const duplicate of candidates.duplicateSessions) {
    await updateAgentAction({
      userId: params.userId,
      actionId: duplicate.id,
      status: "cancelled",
      output: {
        ...(duplicate.output ?? {}),
        cancelledAt: now.toISOString(),
        cancelledReason: "duplicate_visible_renag_session_v2260",
      },
    });
  }

  const fixedWeekdayItemIds: string[] = [];
  for (const candidate of candidates.weekdayItems) {
    const updated = await updatePlannerItemDetails({
      userId: params.userId,
      itemId: candidate.item.id,
      kind: "task",
      title: candidate.title,
      startAt: candidate.startAt,
      endAt: null,
      dueAt: null,
      metadata: {
        repairedBy: "admin_repair_v2260",
        repairedAt: now.toISOString(),
        repairReason: "explicit_weekday_is_schedule_not_deadline",
        previousTitle: candidate.item.title,
        previousDueAt: candidate.item.dueAt?.toISOString() ?? null,
      },
    });
    if (updated) fixedWeekdayItemIds.push(updated.id);
  }

  const normalizedOrthodontistItemIds: string[] = [];
  for (const candidate of candidates.orthodontistItems) {
    await normalizeOrthodontistPolicies({
      userId: params.userId,
      timezone: params.timezone,
      now,
      candidate,
    });
    normalizedOrthodontistItemIds.push(candidate.item.id);
  }

  return {
    deletedOldRenagCards: deletedOldRenagCards.length,
    deletedOldRenagMessageIds: deletedOldRenagCards,
    supersededOldRenagCards: failedOldRenagCards.length + candidates.duplicateSessions.length,
    supersededOldRenagMessageIds: failedOldRenagCards,
    fixedWeekdayItems: fixedWeekdayItemIds.length,
    fixedWeekdayItemIds,
    normalizedOrthodontistReminderTemplates: normalizedOrthodontistItemIds.length,
    normalizedOrthodontistItemIds,
    convertedPinnedNotes: base.convertedPinnedCarNotes,
    cancelledPinnedNotePolicies: base.cancelledCarReminderPolicies,
    calendarObjectsChanged: 0 as const,
    safeToApply: true as const,
  };
}

async function collectV2260Candidates(params: { userId: string; timezone: string; now?: Date }) {
  const now = params.now ?? new Date();
  const [items, policies, pendingActions, audits] = await Promise.all([
    listManageableItems(params.userId, 700),
    listReminderPoliciesForUser(params.userId, 1000),
    listPendingAgentActionsByTypes({
      userId: params.userId,
      actionTypes: [PENDING_PROMPT_RENAG_ACTION],
      limit: 300,
    }),
    listRecentAuditLogs({
      userId: params.userId,
      since: new Date(now.getTime() - 7 * 24 * 60 * 60_000),
      limit: 500,
    }),
  ]);
  const { renagCardsToDelete, duplicateSessions } = collectRenagCleanup(pendingActions);
  const weekdayItems = items
    .map((item) => weekdayRepairCandidate(item, params.timezone))
    .filter((value): value is WeekdayRepairCandidate => Boolean(value));
  const orthodontistItems: OrthodontistCandidate[] = [];
  for (const item of items.filter(
    (entry) =>
      entry.status === "active" &&
      entry.startAt &&
      isOrthodontistVisitTitle(entry.title) &&
      isKnownOrthodontistPairVisit(entry, params.timezone),
  )) {
    const itemPolicies = policies.filter(
      (policy) =>
        policy.itemId === item.id && policy.status === "active" && isEventLinkedPolicy(policy),
    );
    if (!orthodontistPoliciesMatch(item, itemPolicies, params.timezone)) {
      orthodontistItems.push({ item, policies: itemPolicies });
    }
  }
  return {
    pendingActions,
    renagCardsToDelete,
    duplicateSessions,
    weekdayItems,
    orthodontistItems,
    loudDashboardAudits: audits.filter(
      (audit) =>
        audit.action === "assistant.telegram_send_mode" &&
        audit.details?.messageKind === "dashboard_refresh" &&
        audit.details?.disableNotification !== true,
    ).length,
  };
}

function collectRenagCleanup(actions: AgentAction[]) {
  const groups = new Map<string, AgentAction[]>();
  const renagCardsToDelete: Array<{ actionId: string; messageId: number }> = [];
  for (const action of actions) {
    const key = targetGroupKey(action.userId ?? "", action.input ?? {});
    if (key) groups.set(key, [...(groups.get(key) ?? []), action]);
    for (const messageId of numberArray(action.output?.supersededMessageIds)) {
      renagCardsToDelete.push({ actionId: action.id, messageId });
    }
  }
  const duplicateSessions: AgentAction[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );
    for (const duplicate of ordered.slice(1)) {
      duplicateSessions.push(duplicate);
      const messageId = Number(duplicate.output?.lastTelegramMessageId);
      if (Number.isFinite(messageId) && messageId > 0) {
        renagCardsToDelete.push({ actionId: duplicate.id, messageId });
      }
    }
  }
  return {
    duplicateSessions,
    renagCardsToDelete: renagCardsToDelete.filter(
      (entry, index, values) =>
        values.findIndex((candidate) => candidate.messageId === entry.messageId) === index,
    ),
  };
}

function weekdayRepairCandidate(
  item: PlannerItem,
  timezone: string,
): WeekdayRepairCandidate | null {
  if (item.status !== "active" || hasDeadlineIntent(item.title)) return null;
  const appointment = parseRussianWeekdayAppointment({
    text: item.title,
    timezone,
    now: item.createdAt,
  });
  if (!appointment) return null;
  const title = stripRussianWeekdaySchedulePhrase(item.title);
  if (title === item.title) return null;
  const startAt = DateTime.fromISO(appointment.localDateTime, { zone: timezone })
    .toUTC()
    .toJSDate();
  const alreadyCorrect =
    item.startAt?.getTime() === startAt.getTime() && item.dueAt === null && item.title === title;
  return alreadyCorrect ? null : { item, title, startAt };
}

function orthodontistPoliciesMatch(
  item: PlannerItem,
  policies: ReminderPolicy[],
  timezone: string,
) {
  if (!item.startAt) return true;
  const start = DateTime.fromJSDate(item.startAt, { zone: "utc" }).setZone(
    item.timezone || timezone,
  );
  const expected = buildOrthodontistReminderTemplate({ eventStart: start });
  if (policies.length !== expected.length) return false;
  return expected.every((entry) =>
    policies.some(
      (policy) =>
        policy.metadata?.orthodontistTemplate === ORTHODONTIST_TEMPLATE_VERSION &&
        policy.metadata?.orthodontistTemplateRole === entry.templateRole &&
        (policy.nextFireAt ?? policy.startsAt)?.getTime() === entry.fireAt.toUTC().toMillis(),
    ),
  );
}

async function normalizeOrthodontistPolicies(params: {
  userId: string;
  timezone: string;
  now: Date;
  candidate: OrthodontistCandidate;
}) {
  const item = params.candidate.item;
  if (!item.startAt) return;
  for (const policy of params.candidate.policies) {
    if (!isEventLinkedPolicy(policy)) continue;
    await cancelPendingRemindersForPolicy({
      userId: params.userId,
      policyId: policy.id,
      from: params.now,
    });
    await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      status: "cancelled",
      nextFireAt: null,
      metadata: {
        cancelledBy: "admin_repair_v2260",
        cancelReason: "orthodontist_template_normalized",
        cancelledAt: params.now.toISOString(),
      },
    });
  }
  const start = DateTime.fromJSDate(item.startAt, { zone: "utc" }).setZone(
    item.timezone || params.timezone,
  );
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(
    item.timezone || params.timezone,
  );
  for (const entry of buildOrthodontistReminderTemplate({ eventStart: start, now: nowLocal })) {
    const idempotencyKey = `v2260:orthodontist:${item.id}:${entry.templateRole}:${entry.fireAt.toUTC().toISO()}`;
    const policy = await createReminderPolicyIfMissing({
      userId: params.userId,
      itemId: item.id,
      title: item.title,
      category: item.category ?? "health",
      policyType: "before_event",
      timezone: item.timezone || params.timezone,
      startsAt: entry.fireAt.toUTC().toJSDate(),
      nextFireAt: entry.fireAt.toUTC().toJSDate(),
      requireAck: false,
      maxOccurrences: 1,
      idempotencyKey,
      metadata: {
        minutesBefore: entry.minutesBefore,
        relativeLabel: entry.relativeLabel,
        eventMorningSet: entry.eventMorningSet,
        orthodontistTemplate: ORTHODONTIST_TEMPLATE_VERSION,
        orthodontistTemplateRole: entry.templateRole,
        repairedBy: "admin_repair_v2260",
      },
    });
    await createReminderIfMissing({
      userId: params.userId,
      plannerItemId: item.id,
      policyId: policy.id,
      type: "event_before",
      scheduledAt: entry.fireAt.toUTC().toJSDate(),
      idempotencyKey: `${idempotencyKey}:reminder`,
      repeatUntilAck: false,
      purpose: "pre_event",
      menuType: "event_reminder",
      payload: {
        minutesBefore: entry.minutesBefore,
        relativeLabel: entry.relativeLabel,
        eventMorningSet: entry.eventMorningSet,
        orthodontistTemplate: ORTHODONTIST_TEMPLATE_VERSION,
        orthodontistTemplateRole: entry.templateRole,
      },
    });
  }
}

function isEventLinkedPolicy(policy: ReminderPolicy) {
  return (
    policy.policyType === "before_event" ||
    policy.metadata?.reminderType === "event_before" ||
    policy.metadata?.orthodontistTemplate != null
  );
}

function isKnownOrthodontistPairVisit(item: PlannerItem, timezone: string) {
  if (!item.startAt) return false;
  const local = DateTime.fromJSDate(item.startAt, { zone: "utc" }).setZone(
    item.timezone || timezone,
  );
  return local.month === 7 && [1, 2].includes(local.day);
}

function numberArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(Number).filter((entry) => Number.isFinite(entry) && entry > 0)
    : [];
}
