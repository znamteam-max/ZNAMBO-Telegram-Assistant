import { DateTime } from "luxon";

import {
  cancelPlannerItemWithMetadata,
  listAllActiveItems,
  updatePlannerItemForReminderRepair,
} from "@/db/queries/items";
import { createReminderPolicyIfMissing } from "@/db/queries/reminderPolicies";
import { cancelLegacyRemindersWithoutPolicy } from "@/db/queries/reminders";
import type { PlannerItem } from "@/db/schema";

import { reconcileActiveReminderPolicies } from "./reminderPolicyReconciler";

type RepairGroup = "circle" | "drik" | "mirror" | "housing";

export async function previewReminderPolicyRepair(params: {
  userId: string;
  timezone: string;
}) {
  const items = await listAllActiveItems(params.userId, 500);
  const groups = groupLegacyItems(items);
  return {
    groups: Object.entries(groups)
      .filter((entry): entry is [RepairGroup, PlannerItem[]] => entry[1].length > 0)
      .map(([group, records]) => ({
        group,
        itemIds: records.map((item) => item.id),
        titles: records.map((item) => item.title),
        action: repairDescription(group),
      })),
    matchedItemIds: Object.values(groups).flat().map((item) => item.id),
  };
}

export async function applyReminderPolicyRepair(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const preview = await previewReminderPolicyRepair(params);
  const items = await listAllActiveItems(params.userId, 500);
  const groups = groupLegacyItems(items);
  const repairedItems: PlannerItem[] = [];
  const archivedItems: PlannerItem[] = [];
  const policyIds: string[] = [];

  for (const group of ["circle", "drik", "mirror", "housing"] as const) {
    const candidates = groups[group];
    if (!candidates.length) continue;
    const canonical = chooseCanonical(group, candidates);
    for (const duplicate of candidates.filter((item) => item.id !== canonical.id)) {
      const archived = await cancelPlannerItemWithMetadata({
        userId: params.userId,
        itemId: duplicate.id,
        metadata: {
          mutationSource: "admin_repair",
          reminderPolicyRepairVersion: "2.4.1",
          archiveReason: `duplicate_${group}_legacy_reminder`,
        },
      });
      if (archived) archivedItems.push(archived);
    }

    await cancelLegacyRemindersWithoutPolicy(params.userId, candidates.map((item) => item.id));
    const repaired = await repairCanonicalItem({
      group,
      item: canonical,
      userId: params.userId,
      timezone: params.timezone,
    });
    if (!repaired) continue;
    repairedItems.push(repaired);

    const policy = await createRepairPolicy({
      group,
      item: repaired,
      userId: params.userId,
      timezone: params.timezone,
      now,
    });
    policyIds.push(policy.id);
    await updatePlannerItemForReminderRepair({
      userId: params.userId,
      itemId: repaired.id,
      kind: repaired.kind,
      title: repaired.title,
      timezone: repaired.timezone,
      startAt: repaired.startAt,
      endAt: repaired.endAt,
      dueAt: repaired.dueAt,
      category: repaired.category,
      visibility: repaired.visibility,
      sourcePolicyId: policy.id,
      metadata: {
        mutationSource: "admin_repair",
        reminderPolicyRepairVersion: "2.4.1",
      },
    });
  }

  const reconcile = await reconcileActiveReminderPolicies({ now, limit: 200 });
  return {
    preview,
    repairedItems: repairedItems.map(summary),
    archivedItems: archivedItems.map(summary),
    policyIds,
    reconcile,
  };
}

function groupLegacyItems(items: PlannerItem[]): Record<RepairGroup, PlannerItem[]> {
  return {
    circle: items.filter((item) => /(круж.*винбокс|винбокс.*круж)/i.test(item.title)),
    drik: items.filter((item) => /позвонить\s+дрик.*роб/i.test(item.title)),
    mirror: items.filter((item) => /(замен[ауы].*зеркал|зеркал.*автомоб)/i.test(item.title)),
    housing: items.filter((item) => /жкх/i.test(item.title)),
  };
}

function chooseCanonical(group: RepairGroup, items: PlannerItem[]) {
  if (group === "circle") {
    return (
      items.find((item) => /^записать\s+кружок/i.test(item.title)) ??
      items.find((item) => !/^регулярное\s+напоминание/i.test(item.title)) ??
      items[0]
    );
  }
  return items.find((item) => !/^регулярное\s+напоминание/i.test(item.title)) ?? items[0];
}

async function repairCanonicalItem(params: {
  group: RepairGroup;
  item: PlannerItem;
  userId: string;
  timezone: string;
}) {
  const day = DateTime.fromISO("2026-06-08", { zone: params.timezone });
  const definition = {
    circle: {
      title: "Записать кружок с анонсом винбокса",
      kind: "task",
      dueAt: day.set({ hour: 11 }).toUTC().toJSDate(),
      category: "content",
      visibility: "today",
    },
    drik: {
      title: "Позвонить Дрик по поводу Роба",
      kind: "task",
      dueAt: day.set({ hour: 14 }).toUTC().toJSDate(),
      category: "people",
      visibility: "today",
    },
    mirror: {
      title: "Обратиться по поводу замены зеркала в автомобиле",
      kind: "recurring_task",
      dueAt: null,
      category: "car",
      visibility: "long_term",
    },
    housing: {
      title: "Проверить и оплатить ЖКХ",
      kind: "recurring_task",
      dueAt: null,
      category: "finance",
      visibility: "long_term",
    },
  }[params.group];

  return updatePlannerItemForReminderRepair({
    userId: params.userId,
    itemId: params.item.id,
    kind: definition.kind,
    title: definition.title,
    timezone: params.timezone,
    startAt: null,
    endAt: null,
    dueAt: definition.dueAt,
    category: definition.category,
    visibility: definition.visibility,
    metadata: {
      mutationSource: "admin_repair",
      reminderPolicyRepairVersion: "2.4.1",
      legacyTitle: params.item.title,
    },
  });
}

async function createRepairPolicy(params: {
  group: RepairGroup;
  item: PlannerItem;
  userId: string;
  timezone: string;
  now: Date;
}) {
  const day = DateTime.fromISO("2026-06-08", { zone: params.timezone });
  if (params.group === "circle" || params.group === "drik") {
    const startHour = 8;
    const endHour = params.group === "circle" ? 11 : 14;
    const startsAt = day.set({ hour: startHour }).toUTC().toJSDate();
    const endsAt = day.set({ hour: endHour }).toUTC().toJSDate();
    return createReminderPolicyIfMissing({
      userId: params.userId,
      itemId: params.item.id,
      title: params.item.title,
      category: params.group === "circle" ? "content" : "people",
      policyType: "interval_window",
      timezone: params.timezone,
      startsAt,
      endsAt,
      nextFireAt: startsAt,
      intervalMinutes: 30,
      requireAck: true,
      windowEndInclusive: true,
      catchUpMode: "one_immediate_then_resume",
      idempotencyKey: `v2.4.1-repair:${params.group}:${params.item.id}`,
      metadata: {
        mutationSource: "admin_repair",
        stopOnItemComplete: true,
        repairVersion: "2.4.1",
      },
    });
  }

  const weeks = params.group === "mirror" ? 1 : 2;
  const nextFireAt = DateTime.fromJSDate(params.now, { zone: "utc" })
    .setZone(params.timezone)
    .plus({ weeks })
    .startOf("day")
    .set({ hour: 9, minute: 30 })
    .toUTC()
    .toJSDate();
  return createReminderPolicyIfMissing({
    userId: params.userId,
    itemId: params.item.id,
    title: params.item.title,
    category: params.group === "mirror" ? "recurring_car" : "recurring_finance",
    policyType: "long_term",
    timezone: params.timezone,
    nextFireAt,
    recurrenceRule: params.group === "mirror" ? "weekly" : "every_2_weeks",
    requireAck: true,
    catchUpMode: "one_immediate_then_resume",
    idempotencyKey: `v2.4.1-repair:${params.group}:${params.item.id}`,
    metadata: {
      mutationSource: "admin_repair",
      stopOnItemComplete: false,
      repairVersion: "2.4.1",
    },
  });
}

function repairDescription(group: RepairGroup) {
  return {
    circle: "merge to one content task and create 08:00-11:00 interval policy",
    drik: "convert to one task and create 08:00-14:00 interval policy",
    mirror: "convert to weekly long-term car policy",
    housing: "convert to biweekly long-term finance policy",
  }[group];
}

function summary(item: PlannerItem) {
  return { id: item.id, title: item.title };
}
