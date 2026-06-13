import { DateTime } from "luxon";

import { listPendingAgentActionsByTypes, updateAgentAction } from "@/db/queries/agentActions";
import { writeAudit } from "@/db/queries/audit";
import { cancelPlannerItemWithMetadata, listManageableItems } from "@/db/queries/items";
import { createReminderPolicyIfMissing, listReminderPoliciesForItem } from "@/db/queries/reminderPolicies";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";

const CADENCE_ONLY = /^кажд(?:ый|ые)\s+час(?:\s+с\s+8(?:[:.]00)?\s+(?:утра\s+)?до\s+18(?:[:.]00)?)?$/i;

export function isV280CadenceOnlyGarbageTitle(title: string) {
  return CADENCE_ONLY.test(title.trim());
}

export function isV280RepairSafe(garbageCount: number, targetCount: number) {
  return garbageCount === 1 && targetCount === 1;
}

export async function previewV280ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const [items, sessions] = await Promise.all([
    listManageableItems(params.userId, 400),
    listPendingAgentActionsByTypes({
      userId: params.userId,
      actionTypes: ["reminder_policy_edit_session"],
    }),
  ]);
  const garbageCadenceTasks = items.filter(
    (item) =>
      item.status === "active" &&
      item.kind === "task" &&
      isV280CadenceOnlyGarbageTitle(item.title),
  );
  const targetItems = items.filter(
    (item) => item.status === "active" && /перенест.*ортодонт|ортодонт.*перенест/i.test(item.title),
  );
  const staleSessions = sessions.filter((action) => {
    const expiresAt = typeof action.output?.expiresAt === "string" ? new Date(action.output.expiresAt) : null;
    return !expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= now;
  });
  return {
    garbageCadenceTasks,
    targetItems,
    safeToAttach: isV280RepairSafe(garbageCadenceTasks.length, targetItems.length),
    staleSessions,
  };
}

export async function applyV280ProductionRepair(params: { userId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const preview = await previewV280ProductionRepair({ ...params, now });
  const archivedIds: string[] = [];
  const policyIds: string[] = [];
  if (preview.safeToAttach) {
    const target = preview.targetItems[0];
    const anchor = DateTime.fromJSDate(target.startAt ?? target.dueAt ?? now, { zone: "utc" })
      .setZone(target.timezone);
    let starts = anchor.startOf("day").set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
    const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(target.timezone);
    if (starts <= nowLocal) {
      starts = nowLocal.plus({ days: 1 }).startOf("day").set({ hour: 8 });
    }
    const ends = starts.set({ hour: 18 });
    const existing = (await listReminderPoliciesForItem(params.userId, target.id, 30)).find(
      (policy) => policy.status === "active" && policy.policyType === "nag_until_ack",
    );
    if (!existing) {
      const policy = await createReminderPolicyIfMissing({
        userId: params.userId,
        itemId: target.id,
        title: target.title,
        category: target.category ?? "health",
        policyType: "nag_until_ack",
        timezone: target.timezone,
        startsAt: starts.toUTC().toJSDate(),
        endsAt: ends.toUTC().toJSDate(),
        nextFireAt: starts.toUTC().toJSDate(),
        intervalMinutes: 60,
        requireAck: true,
        onWindowEnd: "keep_open",
        idempotencyKey: `${target.id}:v280-repair-hourly-08-18`,
        metadata: {
          repairVersion: "2.8.0",
          stopCondition: "until_done",
          stopOnItemComplete: true,
          activeWindowStart: "08:00",
          activeWindowEnd: "18:00",
        },
      });
      policyIds.push(policy.id);
      await materializeNextPolicyReminder(policy, policy.nextFireAt, { now });
      await writeAudit({
        userId: params.userId,
        action: "assistant.v280_repair_policy_created",
        entityType: "reminder_policy",
        entityId: policy.id,
        details: { targetItemId: target.id, repairVersion: "2.8.0" },
      }).catch(() => undefined);
    }
    for (const item of preview.garbageCadenceTasks) {
      const archived = await cancelPlannerItemWithMetadata({
        userId: params.userId,
        itemId: item.id,
        metadata: {
          archivedBy: "admin_repair_v280",
          archiveReason: "cadence_only_generated_task",
          repairedTargetItemId: target.id,
        },
      });
      if (archived) {
        archivedIds.push(archived.id);
        await writeAudit({
          userId: params.userId,
          action: "assistant.v280_repair_item_archived",
          entityType: "planner_item",
          entityId: archived.id,
          details: { targetItemId: target.id, repairVersion: "2.8.0" },
        }).catch(() => undefined);
      }
    }
  }
  const clearedSessionIds: string[] = [];
  for (const action of preview.staleSessions) {
    const cleared = await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: { ...(action.output ?? {}), cancelledReason: "admin_repair_v280_stale_session" },
    });
    if (cleared) clearedSessionIds.push(cleared.id);
  }
  return { preview, archivedIds, policyIds, clearedSessionIds };
}
