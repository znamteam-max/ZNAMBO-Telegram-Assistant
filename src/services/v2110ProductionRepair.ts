import { DateTime } from "luxon";

import { writeAudit } from "@/db/queries/audit";
import { listPendingAgentActionsByTypes, updateAgentAction } from "@/db/queries/agentActions";
import { listManageableItems, updatePlannerItemSchedule } from "@/db/queries/items";
import {
  listActiveReminderPolicies,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelPendingRemindersForPolicy } from "@/db/queries/reminders";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";

const TARGET_TIMEZONE = "Europe/Moscow";
const SESSION_ACTION_TYPES = [
  "item_edit_session",
  "reminder_policy_edit_session",
  "recurring_policy_draft",
  "external_calendar_edit_session",
];

export function v2110ExpectedWorldCupDueAt() {
  return DateTime.fromObject(
    { year: 2026, month: 6, day: 14, hour: 23, minute: 59 },
    { zone: TARGET_TIMEZONE },
  )
    .toUTC()
    .toJSDate();
}

export function isV2110KnownWorldCupRecapTask(title: string) {
  const normalized = normalizeRu(title);
  return (
    normalized.includes("план") &&
    normalized.includes("длинн") &&
    normalized.includes("обзор") &&
    normalized.includes("событ") &&
    (normalized.includes("чемпионат") || normalized.includes("чм")) &&
    normalized.includes("мир")
  );
}

export function isV2110WrongWorldCupDueAt(dueAt: Date | null | undefined) {
  if (!dueAt) return false;
  return (
    DateTime.fromJSDate(dueAt, { zone: "utc" })
      .setZone(TARGET_TIMEZONE)
      .toFormat("yyyy-MM-dd HH:mm") === "2026-06-15 08:00"
  );
}

export function isV2110ExpectedWorldCupDueAt(dueAt: Date | null | undefined) {
  if (!dueAt) return false;
  return Math.abs(dueAt.getTime() - v2110ExpectedWorldCupDueAt().getTime()) <= 60_000;
}

export async function previewV2110ProductionRepair(params: { userId: string }) {
  const [items, policies, pendingSessions] = await Promise.all([
    listManageableItems(params.userId, 500),
    listActiveReminderPolicies(params.userId, 500),
    listPendingAgentActionsByTypes({
      userId: params.userId,
      actionTypes: SESSION_ACTION_TYPES,
      limit: 100,
    }),
  ]);
  const targetItems = items.filter(
    (item) => item.status === "active" && isV2110KnownWorldCupRecapTask(item.title),
  );
  const target = targetItems.length === 1 ? targetItems[0] : null;
  const targetPolicies = target ? policies.filter((policy) => policy.itemId === target.id) : [];
  const intendedPolicies = targetPolicies.filter(isIntendedWorldCupReminderPolicy);
  const unrelatedAttachedPolicies = targetPolicies.filter(isUnrelatedMirrorPolicy);
  const staleSessions = target
    ? pendingSessions.filter((action) => actionReferencesItem(action, target.id))
    : [];
  const wrongDueAt = target ? isV2110WrongWorldCupDueAt(target.dueAt) : false;
  const alreadyExpectedDueAt = target ? isV2110ExpectedWorldCupDueAt(target.dueAt) : false;
  const safeToApply =
    targetItems.length === 1 &&
    (wrongDueAt || alreadyExpectedDueAt) &&
    target?.status === "active";

  return {
    targetItems,
    targetItemId: target?.id ?? null,
    targetTitle: target?.title ?? null,
    wrongDueAt,
    alreadyExpectedDueAt,
    currentDueAt: target?.dueAt ?? null,
    expectedDueAt: v2110ExpectedWorldCupDueAt(),
    intendedPolicyIds: intendedPolicies.map((policy) => policy.id),
    unrelatedAttachedPolicyIds: unrelatedAttachedPolicies.map((policy) => policy.id),
    staleSessionIds: staleSessions.map((action) => action.id),
    calendarObjectsToDelete: 0,
    safeToApply,
    notes: buildPreviewNotes({
      targetItems,
      target,
      wrongDueAt,
      alreadyExpectedDueAt,
      unrelatedAttachedPolicies,
      staleSessions,
    }),
  };
}

export async function applyV2110ProductionRepair(params: { userId: string }) {
  const preview = await previewV2110ProductionRepair(params);
  const updatedItemIds: string[] = [];
  const normalizedPolicyIds: string[] = [];
  const detachedPolicyIds: string[] = [];
  const clearedSessionIds: string[] = [];
  if (!preview.safeToApply || !preview.targetItemId) {
    return {
      preview,
      updatedItemIds,
      normalizedPolicyIds,
      detachedPolicyIds,
      clearedSessionIds,
      calendarObjectsChanged: 0,
    };
  }

  const [items, policies, pendingSessions] = await Promise.all([
    listManageableItems(params.userId, 500),
    listActiveReminderPolicies(params.userId, 500),
    listPendingAgentActionsByTypes({
      userId: params.userId,
      actionTypes: SESSION_ACTION_TYPES,
      limit: 100,
    }),
  ]);
  const target = items.find((item) => item.id === preview.targetItemId);
  if (!target) {
    return {
      preview,
      updatedItemIds,
      normalizedPolicyIds,
      detachedPolicyIds,
      clearedSessionIds,
      calendarObjectsChanged: 0,
    };
  }

  if (!isV2110ExpectedWorldCupDueAt(target.dueAt)) {
    const updated = await updatePlannerItemSchedule({
      userId: params.userId,
      itemId: target.id,
      startAt: target.startAt,
      endAt: target.endAt,
      dueAt: v2110ExpectedWorldCupDueAt(),
      metadata: {
        repairedBy: "admin_repair_v2110",
        repairReason: "restore_world_cup_recap_deadline_after_stale_session_capture",
        previousDueAt: target.dueAt?.toISOString() ?? null,
      },
    });
    if (updated) updatedItemIds.push(updated.id);
  }

  const expectedStart = DateTime.fromObject(
    { year: 2026, month: 6, day: 14, hour: 20, minute: 0 },
    { zone: TARGET_TIMEZONE },
  )
    .toUTC()
    .toJSDate();
  const expectedEnd = v2110ExpectedWorldCupDueAt();
  for (const policy of policies.filter(
    (candidate) => candidate.itemId === target.id && isIntendedWorldCupReminderPolicy(candidate),
  )) {
    await cancelPendingRemindersForPolicy({
      userId: params.userId,
      policyId: policy.id,
    });
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      title: target.title,
      policyType: "nag_until_ack",
      startsAt: expectedStart,
      endsAt: expectedEnd,
      nextFireAt: policy.nextFireAt && policy.nextFireAt > expectedStart ? policy.nextFireAt : expectedStart,
      intervalMinutes: 30,
      requireAck: true,
      onWindowEnd: "keep_open",
      metadata: {
        activeWindowStart: "20:00",
        activeWindowEnd: "23:59",
        stopCondition: "until_done",
        stopOnItemComplete: true,
        mutationSource: "admin_repair_v2110",
      },
    });
    if (updated) normalizedPolicyIds.push(updated.id);
  }

  for (const policy of policies.filter(
    (candidate) => candidate.itemId === target.id && isUnrelatedMirrorPolicy(candidate),
  )) {
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      itemId: null,
      metadata: {
        detachedBy: "admin_repair_v2110",
        detachedFromItemId: target.id,
        detachReason: "unrelated_global_recurring_policy_attached_by_stale_session",
      },
    });
    if (updated) detachedPolicyIds.push(updated.id);
  }

  for (const action of pendingSessions.filter((candidate) => actionReferencesItem(candidate, target.id))) {
    const updated = await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...(action.output ?? {}),
        cancelledReason: "admin_repair_v2110_stale_session",
        cancelledAt: new Date().toISOString(),
      },
    });
    if (updated) clearedSessionIds.push(updated.id);
  }

  await writeAudit({
    userId: params.userId,
    action: "assistant.v2110_production_repair",
    entityType: "production_repair",
    details: {
      repairVersion: "2.11.0",
      updatedItemIds,
      normalizedPolicyIds,
      detachedPolicyIds,
      clearedSessionIds,
      calendarObjectsChanged: 0,
    },
  }).catch(() => undefined);

  return {
    preview,
    updatedItemIds,
    normalizedPolicyIds,
    detachedPolicyIds,
    clearedSessionIds,
    calendarObjectsChanged: 0,
  };
}

function isIntendedWorldCupReminderPolicy(policy: ReminderPolicy) {
  const metadata = policy.metadata as Record<string, unknown>;
  return (
    policy.policyType === "nag_until_ack" &&
    (policy.intervalMinutes === 30 || Number(metadata.intervalMinutes) === 30) &&
    (metadata.activeWindowStart === "20:00" || policy.startsAt !== null) &&
    (metadata.activeWindowEnd === "23:59" || policy.endsAt !== null)
  );
}

function isUnrelatedMirrorPolicy(policy: ReminderPolicy) {
  const normalized = normalizeRu(policy.title);
  return (
    policy.recurrenceRule?.startsWith("weekly:") === true &&
    (normalized.includes("зеркал") || normalized.includes("машин"))
  );
}

function actionReferencesItem(action: AgentAction, itemId: string) {
  return objectHasItemId(action.input, itemId) || objectHasItemId(action.output, itemId);
}

function objectHasItemId(value: unknown, itemId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.itemId === itemId ||
    record.targetItemId === itemId ||
    record.target_item_id === itemId ||
    Object.values(record).some((entry) => {
      if (Array.isArray(entry)) return entry.includes(itemId);
      if (entry && typeof entry === "object") return objectHasItemId(entry, itemId);
      return false;
    })
  );
}

function buildPreviewNotes(params: {
  targetItems: PlannerItem[];
  target: PlannerItem | null;
  wrongDueAt: boolean;
  alreadyExpectedDueAt: boolean;
  unrelatedAttachedPolicies: ReminderPolicy[];
  staleSessions: AgentAction[];
}) {
  if (params.targetItems.length !== 1) {
    return [`expected exactly one target task, found ${params.targetItems.length}`];
  }
  if (!params.wrongDueAt && !params.alreadyExpectedDueAt) {
    return ["target task found, but dueAt is not the known wrong value or expected repaired value"];
  }
  return [
    params.wrongDueAt ? "known wrong dueAt detected" : "dueAt already matches expected value",
    `unrelated attached weekly policies: ${params.unrelatedAttachedPolicies.length}`,
    `stale sessions for target: ${params.staleSessions.length}`,
    "Yandex Calendar objects will not be deleted",
  ];
}

function normalizeRu(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
