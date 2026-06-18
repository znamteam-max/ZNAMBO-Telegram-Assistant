import { DateTime } from "luxon";

import { listPinnedContextNotes } from "@/db/queries/items";
import {
  listReminderPoliciesForItem,
  listReminderPoliciesForUser,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelItemReminders, createReminderIfMissing } from "@/db/queries/reminders";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { isPinnedContextNote } from "@/domain/pinnedContextNotes";
import { repairCarLocationReminderItem } from "@/services/v2240ProductionRepair";
import { listManageableItems } from "@/db/queries/items";
import { isWrongCarLocationReminder } from "@/services/v2240ProductionRepair";

export async function previewV2250ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const candidates = await collectV2250Candidates(params);
  return {
    duplicateActiveRenagSessions: 0,
    carReminderPoliciesToConvert: candidates.carPolicyIds.length,
    carryoverEndOfDayWrongSnoozes: candidates.wrongEndOfDayPolicies.length,
    technicalBeforeEventLabels: 0,
    calendarObjectsToChange: 0,
    safeToApply: true,
  };
}

export async function applyV2250ProductionRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const candidates = await collectV2250Candidates({ ...params, now });
  const convertedPinnedCarNotes: string[] = [];
  const cancelledCarReminderPolicies: string[] = [];
  const movedEndOfDaySnoozesToTomorrow: string[] = [];
  let pinnedCarNote = candidates.existingPinnedCarNote;

  for (const item of candidates.wrongCarItems) {
    const repaired = await repairCarLocationReminderItem({
      userId: params.userId,
      candidate: item,
      existingPinnedCarNote: pinnedCarNote,
      now,
    });
    pinnedCarNote = repaired.pinnedCarNote;
    if (repaired.converted || repaired.archived) convertedPinnedCarNotes.push(item.id);
    cancelledCarReminderPolicies.push(...repaired.cancelledPolicyIds);
  }

  for (const pinned of candidates.pinnedCarNotesWithPolicies) {
    const policies = await listReminderPoliciesForItem(params.userId, pinned.id, 100);
    for (const policy of policies.filter((entry) => entry.status === "active")) {
      const updated = await updateReminderPolicy({
        userId: params.userId,
        policyId: policy.id,
        status: "cancelled",
        nextFireAt: null,
        snoozedUntil: null,
        metadata: {
          cancelledBy: "admin_repair_v2250",
          cancelReason: "pinned_car_note_must_not_have_reminder_policy",
          cancelledAt: now.toISOString(),
        },
      });
      if (updated) cancelledCarReminderPolicies.push(updated.id);
    }
    await cancelItemReminders(params.userId, pinned.id);
    convertedPinnedCarNotes.push(pinned.id);
  }

  for (const policy of candidates.wrongEndOfDayPolicies) {
    const tomorrow = tomorrowMorning(params.timezone, now);
    const updated = await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      nextFireAt: tomorrow,
      snoozedUntil: tomorrow,
      snoozeScope: "policy",
      metadata: {
        repairedBy: "admin_repair_v2250",
        todayWindowSuppressed: true,
        endOfDaySnoozeSemantic: "resume_tomorrow_morning",
        previousNextFireAt: policy.nextFireAt?.toISOString() ?? null,
        previousSnoozedUntil: policy.snoozedUntil?.toISOString() ?? null,
      },
    });
    if (updated) {
      await createReminderIfMissing({
        userId: params.userId,
        plannerItemId: policy.itemId,
        policyId: policy.id,
        type: "until_ack",
        scheduledAt: tomorrow,
        repeatUntilAck: policy.requireAck,
        idempotencyKey: `v2250:eod-repair:${policy.id}:${tomorrow.toISOString()}`,
        purpose: "snooze",
        menuType: "reminder",
        payload: { repairedBy: "admin_repair_v2250", endOfDaySnoozeSemantic: "resume_tomorrow_morning" },
      });
      movedEndOfDaySnoozesToTomorrow.push(updated.id);
    }
  }

  return {
    supersededDuplicateRenagSessions: 0,
    convertedPinnedCarNotes: [...new Set(convertedPinnedCarNotes)].length,
    convertedPinnedCarNoteIds: [...new Set(convertedPinnedCarNotes)],
    cancelledCarReminderPolicies: [...new Set(cancelledCarReminderPolicies)].length,
    cancelledCarReminderPolicyIds: [...new Set(cancelledCarReminderPolicies)],
    movedEndOfDaySnoozesToTomorrow: movedEndOfDaySnoozesToTomorrow.length,
    movedEndOfDayPolicyIds: movedEndOfDaySnoozesToTomorrow,
    normalizedBeforeEventLabels: 0,
    calendarObjectsChanged: 0,
    safeToApply: true,
  };
}

async function collectV2250Candidates(params: { userId: string; timezone: string; now?: Date }) {
  const now = params.now ?? new Date();
  const [items, pinnedNotes, policies] = await Promise.all([
    listManageableItems(params.userId, 700),
    listPinnedContextNotes(params.userId, 100),
    listReminderPoliciesForUser(params.userId, 700),
  ]);
  const wrongCarItems = items.filter(isWrongCarLocationReminder);
  const pinnedCarNotes = pinnedNotes.filter(
    (item) => isPinnedContextNote(item) && item.metadata?.pinnedCategory === "car_location",
  );
  const pinnedCarNotesWithPolicies: PlannerItem[] = [];
  const carPolicyIds: string[] = [];
  for (const item of [...wrongCarItems, ...pinnedCarNotes]) {
    const active = (await listReminderPoliciesForItem(params.userId, item.id, 100)).filter(
      (policy) => policy.status === "active",
    );
    if (active.length && pinnedCarNotes.some((pinned) => pinned.id === item.id)) {
      pinnedCarNotesWithPolicies.push(item);
    }
    carPolicyIds.push(...active.map((policy) => policy.id));
  }
  return {
    wrongCarItems,
    pinnedCarNotesWithPolicies,
    carPolicyIds,
    wrongEndOfDayPolicies: policies.filter((policy) => isWrongEndOfDaySnooze(policy, params.timezone, now)),
    existingPinnedCarNote: pinnedCarNotes[0] ?? null,
  };
}

function isWrongEndOfDaySnooze(policy: ReminderPolicy, timezone: string, now: Date) {
  if (policy.status !== "active") return false;
  if (policy.policyType !== "nag_until_ack" && policy.metadata?.stopCondition !== "until_done") {
    return false;
  }
  const candidate = policy.snoozedUntil ?? policy.nextFireAt;
  if (!candidate) return false;
  const local = DateTime.fromJSDate(candidate, { zone: "utc" }).setZone(timezone);
  const today = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  return local.hasSame(today, "day") && local.hour === 23 && local.minute === 59;
}

function tomorrowMorning(timezone: string, now: Date) {
  return DateTime.fromJSDate(now, { zone: "utc" })
    .setZone(timezone)
    .plus({ days: 1 })
    .set({ hour: 8, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}
