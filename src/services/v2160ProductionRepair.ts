import { DateTime } from "luxon";

import {
  cancelPlannerItemWithMetadata,
  listManageableItems,
  mergePlannerItemMetadata,
  updatePlannerItemSchedule,
} from "@/db/queries/items";
import {
  createReminderPolicyIfMissing,
  listActiveReminderPolicies,
} from "@/db/queries/reminderPolicies";
import { listPendingAgentActionsByTypes, updateAgentAction } from "@/db/queries/agentActions";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";
import { formatBeforeEventOffset } from "@/domain/reminderPolicyPresentation";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";

export async function previewV2160ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const [items, policies, sessions] = await loadData(params.userId);
  const fakeReminderItemIds = items.filter(isV2160FakeReminderEventItem).map((item) => item.id);
  const centralParkWrongTimeItemIds = items
    .filter((item) => isCentralParkWrongTimeItem(item, now))
    .map((item) => item.id);
  const winlineMissingReminderItemIds = items
    .filter((item) => isWinlineCentralParkItem(item))
    .filter((item) => missingRequiredBeforeEventReminders(item, policies).length > 0)
    .map((item) => item.id);
  const pastImportantItemIds = items
    .filter((item) => isEndedEventLike(item, now))
    .filter((item) => item.priority >= 4 || item.metadata?.important === true)
    .map((item) => item.id);
  const staleSessionActionIds = staleSessionIds(sessions, now);

  return {
    fakeReminderItemIds,
    centralParkWrongTimeItemIds,
    winlineMissingReminderItemIds,
    pastImportantItemIds,
    staleSessionActionIds,
    calendarObjectsToChange: 0,
    safeToApply: true,
    notes: [
      `fake standalone reminder items: ${fakeReminderItemIds.length}`,
      `Central Park 07:xx candidates: ${centralParkWrongTimeItemIds.length}`,
      `Winline/CP items missing 2h/30m reminders: ${winlineMissingReminderItemIds.length}`,
      `past important event annotations: ${pastImportantItemIds.length}`,
      `stale interaction sessions: ${staleSessionActionIds.length}`,
      "Yandex Calendar objects will not be changed",
    ],
  };
}

export async function applyV2160ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const preview = await previewV2160ProductionRepair({ ...params, now });
  const [items, policies, sessions] = await loadData(params.userId);
  const cancelledFakeItemIds: string[] = [];
  const restoredCentralParkItemIds: string[] = [];
  const createdPolicyIds: string[] = [];
  const createdReminderIds: string[] = [];
  const annotatedPastImportantItemIds: string[] = [];
  const clearedSessionActionIds: string[] = [];

  for (const item of items.filter((candidate) =>
    preview.fakeReminderItemIds.includes(candidate.id),
  )) {
    const cancelled = await cancelPlannerItemWithMetadata({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        archivedBy: "admin_repair_v2160",
        archiveReason: "standalone_before_event_reminder_garbage",
        archivedAt: now.toISOString(),
      },
    });
    if (cancelled) cancelledFakeItemIds.push(cancelled.id);
  }

  for (const item of items.filter((candidate) =>
    preview.centralParkWrongTimeItemIds.includes(candidate.id),
  )) {
    const restored = restoreCentralParkTime(item);
    const updated = restored
      ? await updatePlannerItemSchedule({
          userId: params.userId,
          itemId: item.id,
          startAt: restored.startAt,
          endAt: restored.endAt,
          dueAt: null,
          metadata: {
            repairedBy: "admin_repair_v2160",
            repairReason: "central_park_wrong_absolute_reminder_time",
            repairedAt: now.toISOString(),
          },
        })
      : null;
    if (updated) restoredCentralParkItemIds.push(updated.id);
  }

  for (const item of items.filter((candidate) =>
    preview.winlineMissingReminderItemIds.includes(candidate.id),
  )) {
    const missing = missingRequiredBeforeEventReminders(item, policies);
    for (const minutesBefore of missing) {
      const anchor = item.startAt ?? item.dueAt;
      if (!anchor) continue;
      const fireAt = DateTime.fromJSDate(anchor, { zone: "utc" })
        .minus({ minutes: minutesBefore })
        .toJSDate();
      if (fireAt <= now) continue;
      const policy = await createReminderPolicyIfMissing({
        userId: params.userId,
        itemId: item.id,
        title: item.title,
        category: "pre_event",
        policyType: "before_event",
        timezone: item.timezone,
        startsAt: fireAt,
        nextFireAt: fireAt,
        requireAck: false,
        idempotencyKey: `${item.id}:admin-repair-v2160:before-event:${minutesBefore}:${fireAt.toISOString()}`,
        metadata: {
          mutationSource: "admin_repair_v2160",
          minutesBefore,
          relativeLabel: formatBeforeEventOffset(minutesBefore, fireAt, item.timezone),
          repairedAt: now.toISOString(),
        },
      });
      createdPolicyIds.push(policy.id);
      const reminder = await materializeNextPolicyReminder(policy, fireAt, { now });
      if (reminder) createdReminderIds.push(reminder.id);
    }
  }

  for (const item of items.filter((candidate) =>
    preview.pastImportantItemIds.includes(candidate.id),
  )) {
    const updated = await mergePlannerItemMetadata({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        pastImportantNormalizedAt: now.toISOString(),
        repairedBy: "admin_repair_v2160",
        repairReason: "ended_event_not_active_important",
      },
    });
    if (updated) annotatedPastImportantItemIds.push(updated.id);
  }

  for (const action of sessions.filter((candidate) =>
    preview.staleSessionActionIds.includes(candidate.id),
  )) {
    const updated = await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...(action.output ?? {}),
        cancelledReason: "admin_repair_v2160_stale_session",
        cancelledAt: now.toISOString(),
      },
    });
    if (updated) clearedSessionActionIds.push(updated.id);
  }

  return {
    ...preview,
    cancelledFakeItemIds,
    restoredCentralParkItemIds,
    createdPolicyIds: [...new Set(createdPolicyIds)],
    createdReminderIds: [...new Set(createdReminderIds)],
    annotatedPastImportantItemIds,
    clearedSessionActionIds,
  };
}

export function isV2160FakeReminderEventTitle(title: string) {
  const normalized = title.toLocaleLowerCase("ru").replace(/ё/g, "е");
  return (
    /напоминан|напомн/.test(normalized) &&
    /за\s+(?:день|пол\s*часа|полчаса|час|два\s+часа|2\s*часа|30\s*мин)/.test(normalized)
  );
}

async function loadData(userId: string) {
  return Promise.all([
    listManageableItems(userId, 500),
    listActiveReminderPolicies(userId, 500),
    listPendingAgentActionsByTypes({
      userId,
      actionTypes: [
        "item_edit_session",
        "reminder_policy_edit_session",
        "multi_reminder_setup_session",
        "recurring_policy_draft",
      ],
      limit: 100,
    }),
  ]);
}

function isV2160FakeReminderEventItem(item: PlannerItem) {
  if (!["event", "task", "tentative_event"].includes(item.kind)) return false;
  if (item.metadata?.repairedBy === "admin_repair_v2160") return false;
  return isV2160FakeReminderEventTitle(item.title);
}

function isCentralParkWrongTimeItem(item: PlannerItem, now: Date) {
  if (!item.startAt || !/(central|централ)\s+park/i.test(item.title)) return false;
  if (item.startAt <= now) return false;
  const local = DateTime.fromJSDate(item.startAt, { zone: "utc" }).setZone(item.timezone);
  return local.hour === 7;
}

function restoreCentralParkTime(item: PlannerItem) {
  if (!item.startAt) return null;
  const local = DateTime.fromJSDate(item.startAt, { zone: "utc" }).setZone(item.timezone);
  const durationMinutes =
    item.endAt && item.endAt > item.startAt
      ? Math.round((item.endAt.getTime() - item.startAt.getTime()) / 60_000)
      : 60;
  const startLocal = local.set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
  const endLocal = startLocal.plus({ minutes: Math.max(30, durationMinutes) });
  return {
    startAt: startLocal.toUTC().toJSDate(),
    endAt: endLocal.toUTC().toJSDate(),
  };
}

function isWinlineCentralParkItem(item: PlannerItem) {
  if (!["event", "training", "tentative_event"].includes(item.kind)) return false;
  if (!item.startAt && !item.dueAt) return false;
  return (
    /(winline|винлайн|винлаин|вinline)/i.test(item.title) &&
    /(цп|central|централ)/i.test(item.title)
  );
}

function missingRequiredBeforeEventReminders(item: PlannerItem, policies: ReminderPolicy[]) {
  const existing = new Set(
    policies
      .filter(
        (policy) =>
          policy.itemId === item.id &&
          policy.status === "active" &&
          policy.policyType === "before_event",
      )
      .map((policy) => Number(policy.metadata?.minutesBefore))
      .filter((minutes) => Number.isFinite(minutes) && minutes > 0),
  );
  return [120, 30].filter((minutes) => !existing.has(minutes));
}

function isEndedEventLike(item: PlannerItem, now: Date) {
  if (!["event", "training", "tentative_event"].includes(item.kind)) return false;
  const end =
    item.endAt ?? (item.startAt ? new Date(item.startAt.getTime() + 60 * 60 * 1000) : null);
  return Boolean(end && end <= now);
}

function staleSessionIds(actions: AgentAction[], now: Date) {
  const ids = new Set<string>();
  const byTypeAndTarget = new Map<string, AgentAction[]>();
  for (const action of actions) {
    const expiresAt = parseDate(action.output?.expiresAt);
    if (expiresAt && expiresAt <= now) ids.add(action.id);
    const target = actionTargetId(action);
    const key = `${action.actionType}:${target ?? "none"}`;
    byTypeAndTarget.set(key, [...(byTypeAndTarget.get(key) ?? []), action]);
  }
  for (const group of byTypeAndTarget.values()) {
    if (group.length <= 1) continue;
    for (const stale of [...group]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(1)) {
      ids.add(stale.id);
    }
  }
  return [...ids];
}

function actionTargetId(action: AgentAction) {
  const output = action.output ?? {};
  return (
    stringValue(output.itemId) ??
    stringValue(output.activeEditItemId) ??
    stringValue(output.activeSessionTargetItemId) ??
    null
  );
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
