import { DateTime } from "luxon";

import {
  cancelPlannerItemWithMetadata,
  listManageableItems,
  listPinnedContextNotes,
  updatePlannerItemDetails,
} from "@/db/queries/items";
import {
  listReminderPoliciesForItem,
  listReminderPoliciesForUser,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelItemReminders } from "@/db/queries/reminders";
import type { PlannerItem } from "@/db/schema";
import { isPinnedContextNote } from "@/domain/pinnedContextNotes";
import { isTodayUntilDoneReminderPolicy } from "@/domain/todayUntilDoneTask";
import { carryForwardUntilDonePolicy } from "@/services/reminderPolicyReconciler";

export async function previewV2240ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const candidates = await collectV2240Candidates(params);
  return {
    carLocationReminderCandidates: candidates.carItems.length,
    carLocationReminderItemIds: candidates.carItems.map((item) => item.id),
    attachedCarPolicies: candidates.carPolicyCount,
    carryoverPolicies: candidates.carryoverPolicies.length,
    carryoverPolicyIds: candidates.carryoverPolicies.map((policy) => policy.id),
    existingPinnedCarNoteId: candidates.existingPinnedCarNote?.id ?? null,
    calendarObjectsToChange: 0,
    safeToApply: true,
  };
}

export async function applyV2240ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const candidates = await collectV2240Candidates({ ...params, now });
  let pinnedCarNote = candidates.existingPinnedCarNote;
  const repairedCarItemIds: string[] = [];
  const archivedDuplicateCarItemIds: string[] = [];
  const cancelledPolicyIds: string[] = [];
  const carriedPolicyIds: string[] = [];

  for (const candidate of candidates.carItems) {
    const repaired = await repairCarLocationReminderItem({
      userId: params.userId,
      candidate,
      existingPinnedCarNote: pinnedCarNote,
      now,
    });
    pinnedCarNote = repaired.pinnedCarNote;
    cancelledPolicyIds.push(...repaired.cancelledPolicyIds);
    if (repaired.converted) repairedCarItemIds.push(candidate.id);
    if (repaired.archived) archivedDuplicateCarItemIds.push(candidate.id);
  }

  for (const policy of candidates.carryoverPolicies) {
    const carried = await carryForwardUntilDonePolicy(policy, now);
    if (carried) carriedPolicyIds.push(carried.id);
  }

  return {
    carLocationReminderCandidates: candidates.carItems.length,
    repairedCarItemIds,
    archivedDuplicateCarItemIds,
    cancelledPolicyIds,
    carryoverPolicies: candidates.carryoverPolicies.length,
    carriedPolicyIds,
    pinnedCarNoteId: pinnedCarNote?.id ?? null,
    calendarObjectsChanged: 0,
    calendarObjectsToChange: 0,
    safeToApply: true,
  };
}

export async function repairCarLocationReminderItem(params: {
  userId: string;
  candidate: PlannerItem;
  existingPinnedCarNote?: PlannerItem | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const policies = await listReminderPoliciesForItem(params.userId, params.candidate.id, 100);
  const cancelledPolicyIds: string[] = [];
  for (const policy of policies) {
    if (policy.status === "cancelled") continue;
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      status: "cancelled",
      nextFireAt: null,
      snoozedUntil: null,
      snoozeScope: null,
      metadata: {
        cancelledBy: "admin_repair_v2240",
        cancelledAt: now.toISOString(),
        cancelReason: "car_location_must_be_pinned_context",
      },
    });
    if (updated) cancelledPolicyIds.push(updated.id);
  }
  await cancelItemReminders(params.userId, params.candidate.id);

  if (!params.existingPinnedCarNote) {
    const pinnedCarNote = await updatePlannerItemDetails({
      userId: params.userId,
      itemId: params.candidate.id,
      kind: "note",
      title: "Машина",
      description: carLocationBody(params.candidate),
      startAt: null,
      endAt: null,
      dueAt: null,
      category: "pinned_context",
      visibility: "active",
      sourcePolicyId: null,
      metadata: {
        pinnedContext: true,
        pinnedCategory: "car_location",
        convertedBy: "admin_repair_v2240",
        convertedAt: now.toISOString(),
        mutableByReminderFlow: false,
        excludeFromRecurringPolicyResolution: true,
        originalReminderTitle: params.candidate.title,
      },
    });
    if (!pinnedCarNote) throw new Error("car_location_pinned_repair_failed");
    return {
      pinnedCarNote,
      cancelledPolicyIds,
      converted: true,
      archived: false,
    };
  }

  const pinnedCarNote =
    (await updatePlannerItemDetails({
      userId: params.userId,
      itemId: params.existingPinnedCarNote.id,
      description: carLocationBody(params.candidate),
      startAt: null,
      endAt: null,
      dueAt: null,
      sourcePolicyId: null,
      metadata: {
        pinnedContext: true,
        pinnedCategory: "car_location",
        updatedBy: "admin_repair_v2240",
        updatedAt: now.toISOString(),
      },
    })) ?? params.existingPinnedCarNote;
  const archived = await cancelPlannerItemWithMetadata({
    userId: params.userId,
    itemId: params.candidate.id,
    metadata: {
      archivedBy: "admin_repair_v2240",
      archivedAt: now.toISOString(),
      archiveReason: "duplicate_car_location_reminder_repaired_to_pinned_note",
      replacementPinnedNoteId: pinnedCarNote.id,
    },
  });
  return {
    pinnedCarNote,
    cancelledPolicyIds,
    converted: false,
    archived: Boolean(archived),
  };
}

async function collectV2240Candidates(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const [items, pinnedNotes, policies] = await Promise.all([
    listManageableItems(params.userId, 700),
    listPinnedContextNotes(params.userId, 100),
    listReminderPoliciesForUser(params.userId, 700),
  ]);
  const carItems = items.filter(isWrongCarLocationReminder);
  const carPolicies = await Promise.all(
    carItems.map((item) => listReminderPoliciesForItem(params.userId, item.id, 100)),
  );
  const itemById = new Map(items.map((item) => [item.id, item]));
  const todayStart = DateTime.fromJSDate(now, { zone: "utc" })
    .setZone(params.timezone)
    .startOf("day")
    .toUTC()
    .toJSDate();
  const carryoverPolicies = policies.filter((policy) => {
    if (!isTodayUntilDoneReminderPolicy(policy) || !policy.itemId) return false;
    if (policy.status === "cancelled") return false;
    const item = itemById.get(policy.itemId);
    return Boolean(
      item &&
        item.status === "active" &&
        policy.endsAt &&
        policy.endsAt < todayStart,
    );
  });
  return {
    carItems,
    carPolicyCount: carPolicies.flat().filter((policy) => policy.status !== "cancelled").length,
    existingPinnedCarNote:
      pinnedNotes.find((item) => item.metadata?.pinnedCategory === "car_location") ?? null,
    carryoverPolicies,
  };
}

export function isWrongCarLocationReminder(item: PlannerItem) {
  if (item.status !== "active" || isPinnedContextNote(item)) return false;
  const text = `${item.title} ${item.description ?? ""}`.toLocaleLowerCase("ru");
  const hasCar = /машин|автомобил|парков/.test(text);
  const hasLocationSignal =
    /оставлен|оставил|стоит|припарк|парков|вкусвилл|рошал|клиник/.test(text);
  const hasReminderShape =
    item.kind !== "note" ||
    Boolean(item.startAt || item.endAt || item.dueAt || item.sourcePolicyId) ||
    /напоминан/.test(text);
  return hasCar && hasLocationSignal && hasReminderShape;
}

function carLocationBody(item: PlannerItem) {
  const source = (item.description || item.title)
    .replace(/^напоминание\s+об?\s*/iu, "")
    .replace(/^оставленной\s+машине\s*/iu, "")
    .replace(/^машину\s+оставил(?:а)?\s*/iu, "")
    .replace(/[.]+$/u, "")
    .trim();
  return source || item.title;
}
