import { and, eq, gte, lte } from "drizzle-orm";

import { getDb } from "@/db/client";
import { plannerItems } from "@/db/schema";
import {
  cancelPlannerItemWithMetadata,
  listManageableItems,
  updatePlannerItemDetails,
} from "@/db/queries/items";
import { stopPoliciesForItem } from "@/db/queries/reminderPolicies";
import { cancelItemReminders } from "@/db/queries/reminders";
import { writeAudit } from "@/db/queries/audit";
import { parseWeeklyTaskReminderIntent } from "@/domain/weeklyTaskReminderIntent";

import { createOrUpdateWeeklyTaskReminderFromIntent } from "./weeklyTaskReminderCreation";

const REPAIR_MARKER = "v308_weekly_task_incident_2026_09_14";
const BAD_TITLE = "В 08:00 и напоминай";
const OLD_TITLE = "Подготовка тем для эфира Больше лайф";
const CANONICAL_TITLE = "Подготовить темы для эфира Больше Live";
const WRONG_MEETING_TITLE = "В созвон с Олей из Винлайн по Рус. Баскету";
const FIXED_MEETING_TITLE = "Созвон с Олей из Винлайн по Рус. Баскету";
const INCIDENT_FROM = new Date("2026-09-14T06:15:00.000Z");
const INCIDENT_TO = new Date("2026-09-14T06:20:30.000Z");
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

  const wrongMeeting = items.find(
    (item) =>
      item.title === WRONG_MEETING_TITLE &&
      item.startAt?.toISOString() === "2026-09-14T09:00:00.000Z",
  );
  if (wrongMeeting) {
    const updatedMeeting = await updatePlannerItemDetails({
      userId,
      itemId: wrongMeeting.id,
      title: FIXED_MEETING_TITLE,
      metadata: {
        repairMarker: REPAIR_MARKER,
        repairedFromTitle: WRONG_MEETING_TITLE,
        repairedAt: now.toISOString(),
      },
    });
    if (updatedMeeting) changes.push(`fixed_meeting_title:${wrongMeeting.id}`);
  }

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

function normalizeTitle(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
