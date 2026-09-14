import { and, eq, gte, lte } from "drizzle-orm";

import { getDb } from "@/db/client";
import { plannerItems } from "@/db/schema";
import {
  cancelPlannerItemWithMetadata,
  listManageableItems,
  updatePlannerItemDetails,
} from "@/db/queries/items";
import {
  listReminderPoliciesForItem,
  stopPoliciesForItem,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import {
  cancelItemReminders,
  cancelPendingRemindersForPolicy,
} from "@/db/queries/reminders";
import { writeAudit } from "@/db/queries/audit";
import { parseWeeklyTaskReminderIntent } from "@/domain/weeklyTaskReminderIntent";

import { materializeNextPolicyReminder } from "./reminderPolicyEngine";
import { createOrUpdateWeeklyTaskReminderFromIntent } from "./weeklyTaskReminderCreation";

const REPAIR_MARKER = "v308_weekly_task_incident_2026_09_14";
const BAD_TITLE = "В 08:00 и напоминай";
const OLD_TITLE = "Подготовка тем для эфира Больше лайф";
const CANONICAL_TITLE = "Подготовить темы для эфира Больше Live";
const WRONG_MEETING_TITLE = "В созвон с Олей из Винлайн по Рус. Баскету";
const FIXED_MEETING_TITLE = "Созвон с Олей из Винлайн по Рус. Баскету";
const INCIDENT_FROM = new Date("2026-09-14T06:15:00.000Z");
const INCIDENT_TO = new Date("2026-09-14T06:20:30.000Z");
const OLYA_START_AT = "2026-09-14T09:00:00.000Z";
const OLYA_POLICY_START_FROM = new Date("2026-09-13T12:15:00.000Z");
const OLYA_POLICY_START_TO = new Date("2026-09-13T12:25:00.000Z");
const EXACT_PROMPT =
  "Каждую пятницу создавай задачу «Подготовить темы для эфира Больше Live». Дедлайн — в эту пятницу в 13:00. Начинай напоминать в 08:00 и напоминай каждый час до 13:00, пока я не отмечу задачу выполненной.";

export async function repairV308WeeklyTaskIncident(params?: { now?: Date }) {
  const now = params?.now ?? new Date();
  const badCandidates = await getDb()
    .select()
    .from(plannerItems)
    .where(
      and(
        eq(plannerItems.status, "active"),
        eq(plannerItems.title, BAD_TITLE),
        gte(plannerItems.createdAt, INCIDENT_FROM),
        lte(plannerItems.createdAt, INCIDENT_TO),
      ),
    )
    .limit(3);

  if (badCandidates.length === 0) {
    return { checked: true, changed: false, reason: "incident_item_not_active" };
  }
  if (badCandidates.length !== 1) {
    return {
      checked: true,
      changed: false,
      reason: "ambiguous_incident_items",
      candidateCount: badCandidates.length,
    };
  }

  const badItem = badCandidates[0];
  const userId = badItem.userId;
  const items = await listManageableItems(userId, 400);
  const existingTargets = items.filter((item) => {
    const title = normalizeTitle(item.title);
    return title === normalizeTitle(OLD_TITLE) || title === normalizeTitle(CANONICAL_TITLE);
  });
  if (existingTargets.length > 1) {
    return {
      checked: true,
      changed: false,
      reason: "ambiguous_existing_weekly_task",
      candidateIds: existingTargets.map((item) => item.id),
    };
  }

  const intent = parseWeeklyTaskReminderIntent({
    text: EXACT_PROMPT,
    timezone: badItem.timezone || "Europe/Moscow",
  });
  if (!intent) {
    return { checked: true, changed: false, reason: "canonical_intent_parse_failed" };
  }

  const changes: string[] = [];
  const existingTarget = existingTargets[0] ?? null;
  if (existingTarget && existingTarget.title !== CANONICAL_TITLE) {
    const renamed = await updatePlannerItemDetails({
      userId,
      itemId: existingTarget.id,
      title: CANONICAL_TITLE,
      metadata: {
        repairMarker: REPAIR_MARKER,
        repairedFromTitle: existingTarget.title,
        repairedAt: now.toISOString(),
      },
    });
    if (!renamed) {
      return { checked: true, changed: false, reason: "existing_target_rename_failed" };
    }
    changes.push(`canonicalized_existing_task:${existingTarget.id}`);
  }

  const canonical = await createOrUpdateWeeklyTaskReminderFromIntent({
    userId,
    sourceMessageId: null,
    intent,
    now,
  });
  await updatePlannerItemDetails({
    userId,
    itemId: canonical.item.id,
    metadata: {
      v308WeeklyTaskIncidentRepairDone: true,
      repairMarker: REPAIR_MARKER,
      repairedAt: now.toISOString(),
    },
  });
  changes.push(`configured_canonical_weekly_task:${canonical.item.id}`);

  // Repair the other still-live Sep 14 incident before retiring the malformed weekly
  // item. This is exact-title + exact-event-time + narrow-policy-start guarded, so a
  // later user-created rule cannot be reactivated accidentally.
  const olyaChanges = await repairOlyaMeetingIncident({ userId, items, now });
  changes.push(...olyaChanges);

  await cancelItemReminders(userId, badItem.id);
  await stopPoliciesForItem(userId, badItem.id);
  const cancelledBad = await cancelPlannerItemWithMetadata({
    userId,
    itemId: badItem.id,
    metadata: {
      repairMarker: REPAIR_MARKER,
      cancelReason: "malformed_weekly_task_from_sep14_ai_parse",
      repairedAt: now.toISOString(),
    },
  });
  if (cancelledBad) changes.push(`cancelled_malformed_task:${badItem.id}`);

  await writeAudit({
    userId,
    action: "assistant.v308_weekly_task_incident_repaired",
    entityType: "production_repair",
    entityId: REPAIR_MARKER,
    details: {
      changes,
      badItemId: badItem.id,
      canonicalItemId: canonical.item.id,
      canonicalPolicyId: canonical.policy.id,
      repairedAt: now.toISOString(),
    },
  }).catch(() => undefined);

  return { checked: true, changed: changes.length > 0, changes };
}

async function repairOlyaMeetingIncident(params: {
  userId: string;
  items: Awaited<ReturnType<typeof listManageableItems>>;
  now: Date;
}) {
  const changes: string[] = [];
  const meetingCandidates = params.items.filter(
    (item) =>
      [WRONG_MEETING_TITLE, FIXED_MEETING_TITLE].includes(item.title) &&
      item.startAt?.toISOString() === OLYA_START_AT,
  );
  if (meetingCandidates.length !== 1) return changes;

  const meeting = meetingCandidates[0];
  if (meeting.title === WRONG_MEETING_TITLE) {
    const updatedMeeting = await updatePlannerItemDetails({
      userId: params.userId,
      itemId: meeting.id,
      title: FIXED_MEETING_TITLE,
      metadata: {
        repairMarker: REPAIR_MARKER,
        repairedFromTitle: WRONG_MEETING_TITLE,
        repairedAt: params.now.toISOString(),
      },
    });
    if (updatedMeeting) changes.push(`fixed_meeting_title:${meeting.id}`);
  }

  const policies = await listReminderPoliciesForItem(params.userId, meeting.id, 100);
  const policyCandidates = policies.filter(
    (policy) =>
      policy.policyType === "nag_until_ack" &&
      policy.intervalMinutes === 240 &&
      Boolean(policy.startsAt) &&
      policy.startsAt! >= OLYA_POLICY_START_FROM &&
      policy.startsAt! <= OLYA_POLICY_START_TO &&
      Boolean(policy.endsAt),
  );
  if (policyCandidates.length !== 1) return changes;

  const policy = policyCandidates[0];
  const anchor = policy.startsAt;
  if (!anchor) return changes;
  const nextFireAt = nextIntervalGridAfter({
    anchor,
    intervalMinutes: 240,
    now: params.now,
  });
  await cancelPendingRemindersForPolicy({
    userId: params.userId,
    policyId: policy.id,
    from: new Date(0),
  });
  const updatedPolicy = await updateReminderPolicy({
    userId: params.userId,
    policyId: policy.id,
    status: "active",
    endsAt: null,
    nextFireAt,
    requireAck: true,
    snoozedUntil: null,
    snoozeScope: null,
    metadata: {
      repairMarker: REPAIR_MARKER,
      repairedAt: params.now.toISOString(),
      endOfDayExplicit: false,
      activeWindowEnd: null,
      finiteWindow: false,
      stopCondition: "until_done",
    },
  });
  if (updatedPolicy) {
    await materializeNextPolicyReminder(updatedPolicy, nextFireAt, { now: params.now });
    changes.push(`reopened_olya_until_done_policy:${policy.id}`);
  }
  return changes;
}

export function nextIntervalGridAfter(params: {
  anchor: Date;
  intervalMinutes: number;
  now: Date;
}) {
  const intervalMs = params.intervalMinutes * 60_000;
  if (intervalMs <= 0) throw new Error("intervalMinutes must be positive");
  if (params.now < params.anchor) return params.anchor;
  const elapsed = params.now.getTime() - params.anchor.getTime();
  const steps = Math.floor(elapsed / intervalMs) + 1;
  return new Date(params.anchor.getTime() + steps * intervalMs);
}

function normalizeTitle(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}