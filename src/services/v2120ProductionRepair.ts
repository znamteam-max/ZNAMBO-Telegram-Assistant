import { writeAudit } from "@/db/queries/audit";
import { listPendingAgentActionsByTypes, updateAgentAction } from "@/db/queries/agentActions";
import { listManageableItems, updatePlannerItemDetails } from "@/db/queries/items";
import {
  createReminderPolicyIfMissing,
  listActiveReminderPolicies,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelPendingRemindersForPolicy } from "@/db/queries/reminders";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";
import {
  nextRecurringOccurrence,
  normalizeRecurringReminderTitle,
  parseCanonicalRecurrenceRule,
} from "@/domain/recurringPolicySemantics";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";

const TARGET_TIMEZONE = "Europe/Moscow";
const MIRROR_TITLE = "Решить вопрос с зеркалом для машины";
const MIRROR_RULE = "weekly:MO@08:00";
const SESSION_ACTION_TYPES = [
  "item_edit_session",
  "reminder_policy_edit_session",
  "recurring_policy_draft",
  "external_calendar_edit_session",
];

export async function previewV2120ProductionRepair(params: { userId: string; now?: Date }) {
  const [items, policies, pendingSessions] = await Promise.all([
    listManageableItems(params.userId, 500),
    listActiveReminderPolicies(params.userId, 500),
    listPendingAgentActionsByTypes({
      userId: params.userId,
      actionTypes: SESSION_ACTION_TYPES,
      limit: 100,
    }),
  ]);
  const mirrorItems = items.filter(isMirrorItem);
  const mirrorItem = mirrorItems.length === 1 ? mirrorItems[0] : null;
  const mirrorPolicies = policies.filter((policy) => isMirrorPolicy(policy, mirrorItem));
  const malformedMirrorPolicies = mirrorPolicies.filter((policy) =>
    isMalformedMirrorPolicy(policy, mirrorItem),
  );
  const targetPolicy = mirrorPolicies.find(isExpectedMirrorPolicy) ?? null;
  const fedotovBrokenPolicies = policies.filter(isBrokenFedotovPolicy);
  const staleSessions = pendingSessions.filter((action) =>
    mirrorItem ? actionReferencesItem(action, mirrorItem.id) || SESSION_ACTION_TYPES.includes(action.actionType) : true,
  );
  const safeToApply = mirrorItems.length <= 1;

  return {
    mirrorItemIds: mirrorItems.map((item) => item.id),
    mirrorItemId: mirrorItem?.id ?? null,
    mirrorCurrentTitle: mirrorItem?.title ?? null,
    mirrorExpectedTitle: MIRROR_TITLE,
    mirrorNeedsRename: Boolean(mirrorItem && mirrorItem.title !== MIRROR_TITLE),
    mirrorMalformedPolicyIds: malformedMirrorPolicies.map((policy) => policy.id),
    mirrorTargetPolicyId: targetPolicy?.id ?? null,
    mirrorTargetPolicy: "weekly Monday 08:00-20:00 every 60 min until done",
    fedotovBrokenPolicyIds: fedotovBrokenPolicies.map((policy) => policy.id),
    staleSessionIds: staleSessions.map((action) => action.id),
    calendarObjectsToChange: 0,
    safeToApply,
    notes: buildPreviewNotes({
      mirrorItems,
      malformedMirrorPolicies,
      targetPolicy,
      fedotovBrokenPolicies,
      staleSessions,
    }),
  };
}

export async function applyV2120ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const preview = await previewV2120ProductionRepair({ ...params, now });
  const renamedItemIds: string[] = [];
  const replacedPolicyIds: string[] = [];
  const targetPolicyIds: string[] = [];
  const fedotovMovedToReviewIds: string[] = [];
  const clearedSessionIds: string[] = [];
  if (!preview.safeToApply) {
    return {
      preview,
      renamedItemIds,
      replacedPolicyIds,
      targetPolicyIds,
      fedotovMovedToReviewIds,
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
  const mirrorItem = items.filter(isMirrorItem)[0] ?? null;
  const nextFireAt = nextRecurringOccurrence({
    rule: MIRROR_RULE,
    after: now,
    timezone: mirrorItem?.timezone || TARGET_TIMEZONE,
  });

  if (mirrorItem) {
    if (mirrorItem.title !== MIRROR_TITLE) {
      const updated = await updatePlannerItemDetails({
        userId: params.userId,
        itemId: mirrorItem.id,
        title: MIRROR_TITLE,
        metadata: {
          repairedBy: "admin_repair_v2120",
          repairVersion: "2.12.0",
          previousTitle: mirrorItem.title,
        },
      });
      if (updated) renamedItemIds.push(updated.id);
    }

    const mirrorPolicies = policies.filter((policy) => isMirrorPolicy(policy, mirrorItem));
    const primaryPolicies = mirrorPolicies.filter((policy) =>
      isMalformedMirrorPolicy(policy, mirrorItem),
    );
    const target = mirrorPolicies.find(isExpectedMirrorPolicy) ?? primaryPolicies[0] ?? null;
    const snoozedUntil = latestFutureSnooze(mirrorPolicies, now);
    if (nextFireAt) {
      const policy = target
        ? await updateReminderPolicy({
            userId: params.userId,
            policyId: target.id,
            itemId: mirrorItem.id,
            status: "active",
            title: MIRROR_TITLE,
            category: mirrorItem.category ?? "recurring_car",
            policyType: "recurring",
            startsAt: null,
            endsAt: null,
            nextFireAt,
            recurrenceRule: MIRROR_RULE,
            intervalMinutes: 60,
            requireAck: true,
            onWindowEnd: "keep_open",
            catchUpMode: "one_immediate_then_resume",
            snoozedUntil,
            snoozeScope: snoozedUntil ? "policy" : null,
            metadata: mirrorPolicyMetadata(now),
          })
        : await createReminderPolicyIfMissing({
            userId: params.userId,
            itemId: mirrorItem.id,
            title: MIRROR_TITLE,
            category: mirrorItem.category ?? "recurring_car",
            policyType: "recurring",
            timezone: mirrorItem.timezone || TARGET_TIMEZONE,
            startsAt: null,
            endsAt: null,
            nextFireAt,
            recurrenceRule: MIRROR_RULE,
            intervalMinutes: 60,
            requireAck: true,
            onWindowEnd: "keep_open",
            catchUpMode: "one_immediate_then_resume",
            snoozedUntil,
            snoozeScope: snoozedUntil ? "policy" : null,
            idempotencyKey: `${mirrorItem.id}:v2120-mirror-weekly-mo-0800-2000`,
            metadata: mirrorPolicyMetadata(now),
          });
      if (policy) {
        targetPolicyIds.push(policy.id);
        await cancelPendingRemindersForPolicy({ userId: params.userId, policyId: policy.id });
        await materializeNextPolicyReminder(policy, nextFireAt, { now });
        for (const duplicate of mirrorPolicies.filter((candidate) => candidate.id !== policy.id)) {
          await cancelPendingRemindersForPolicy({
            userId: params.userId,
            policyId: duplicate.id,
          });
          const updated = await updateReminderPolicy({
            userId: params.userId,
            policyId: duplicate.id,
            status: "cancelled",
            nextFireAt: null,
            metadata: {
              supersededByPolicyId: policy.id,
              supersededBy: "admin_repair_v2120",
              supersededAt: now.toISOString(),
              repairVersion: "2.12.0",
            },
          });
          if (updated) replacedPolicyIds.push(updated.id);
        }
      }
    }
  }

  for (const policy of policies.filter(isBrokenFedotovPolicy)) {
    await cancelPendingRemindersForPolicy({ userId: params.userId, policyId: policy.id });
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      status: "paused",
      nextFireAt: null,
      metadata: {
        needsReview: true,
        hiddenFromDashboard: true,
        reviewReason: "unsafe_legacy_window_or_300_min_interval",
        movedToReviewBy: "admin_repair_v2120",
        repairVersion: "2.12.0",
      },
    });
    if (updated) fedotovMovedToReviewIds.push(updated.id);
  }

  for (const action of pendingSessions.filter((candidate) =>
    mirrorItem
      ? actionReferencesItem(candidate, mirrorItem.id) || SESSION_ACTION_TYPES.includes(candidate.actionType)
      : SESSION_ACTION_TYPES.includes(candidate.actionType),
  )) {
    const updated = await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...(action.output ?? {}),
        cancelledReason: "admin_repair_v2120_stale_session",
        cancelledAt: now.toISOString(),
      },
    });
    if (updated) clearedSessionIds.push(updated.id);
  }

  await writeAudit({
    userId: params.userId,
    action: "assistant.v2120_production_repair",
    entityType: "production_repair",
    details: {
      repairVersion: "2.12.0",
      renamedItemIds,
      replacedPolicyIds,
      targetPolicyIds,
      fedotovMovedToReviewIds,
      clearedSessionIds,
      calendarObjectsChanged: 0,
    },
  }).catch(() => undefined);

  return {
    preview,
    renamedItemIds,
    replacedPolicyIds,
    targetPolicyIds,
    fedotovMovedToReviewIds,
    clearedSessionIds,
    calendarObjectsChanged: 0,
  };
}

export function isV2120MirrorItem(item: PlannerItem) {
  return isMirrorItem(item);
}

export function isV2120BrokenFedotovPolicy(policy: ReminderPolicy) {
  return isBrokenFedotovPolicy(policy);
}

function mirrorPolicyMetadata(now: Date) {
  return {
    activeWindowStart: "08:00",
    activeWindowEnd: "20:00",
    stopCondition: "until_done",
    stopOnItemComplete: true,
    ackAliases: ["done"],
    recurrenceRuleVersion: "canonical-v2100",
    mutationSource: "admin_repair_v2120",
    repairedAt: now.toISOString(),
    repairVersion: "2.12.0",
  };
}

function isMirrorItem(item: PlannerItem) {
  const normalized = normalize(normalizeRecurringReminderTitle(item.title));
  return normalized.includes("зеркал") && normalized.includes("машин");
}

function isMirrorPolicy(policy: ReminderPolicy, mirrorItem?: PlannerItem | null) {
  const normalized = normalize(normalizeRecurringReminderTitle(policy.title));
  return (
    (mirrorItem ? policy.itemId === mirrorItem.id : false) ||
    (normalized.includes("зеркал") && normalized.includes("машин"))
  );
}

function isExpectedMirrorPolicy(policy: ReminderPolicy) {
  return (
    policy.recurrenceRule === MIRROR_RULE &&
    policy.intervalMinutes === 60 &&
    policy.requireAck === true &&
    policy.metadata?.activeWindowStart === "08:00" &&
    policy.metadata?.activeWindowEnd === "20:00"
  );
}

function isMalformedMirrorPolicy(policy: ReminderPolicy, mirrorItem?: PlannerItem | null) {
  if (!isMirrorPolicy(policy, mirrorItem)) return false;
  const parsed = parseCanonicalRecurrenceRule(policy.recurrenceRule);
  const weeklyDefault =
    parsed?.kind === "weekly" && parsed.weekday === "MO" && parsed.timeLocal === "09:00";
  const hourlyOneDay =
    policy.policyType === "nag_until_ack" &&
    Boolean(policy.intervalMinutes) &&
    !policy.recurrenceRule;
  return weeklyDefault || hourlyOneDay || !isExpectedMirrorPolicy(policy);
}

function isBrokenFedotovPolicy(policy: ReminderPolicy) {
  const normalized = normalize(policy.title);
  const fedotov = normalized.includes("федотов") || normalized.includes("сергея федотова");
  const endClock =
    typeof policy.metadata?.activeWindowEnd === "string"
      ? policy.metadata.activeWindowEnd
      : policy.endsAt
        ? localClock(policy.endsAt, policy.timezone || TARGET_TIMEZONE)
        : "";
  return fedotov && (policy.intervalMinutes === 300 || endClock === "02:59");
}

function latestFutureSnooze(policies: ReminderPolicy[], now: Date) {
  return (
    policies
      .map((policy) => policy.snoozedUntil)
      .filter((date): date is Date => Boolean(date && date > now))
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? null
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

function localClock(value: Date, timezone: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(value);
}

function buildPreviewNotes(params: {
  mirrorItems: PlannerItem[];
  malformedMirrorPolicies: ReminderPolicy[];
  targetPolicy: ReminderPolicy | null;
  fedotovBrokenPolicies: ReminderPolicy[];
  staleSessions: AgentAction[];
}) {
  if (params.mirrorItems.length > 1) {
    return [`expected at most one mirror item, found ${params.mirrorItems.length}`];
  }
  return [
    `mirror malformed policies: ${params.malformedMirrorPolicies.length}`,
    params.targetPolicy ? "mirror target policy already exists" : "mirror target policy will be created or normalized",
    `Fedotov policies to review: ${params.fedotovBrokenPolicies.length}`,
    `stale sessions: ${params.staleSessions.length}`,
    "Yandex Calendar objects will not be changed",
  ];
}

function normalize(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
