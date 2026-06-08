import { and, asc, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { createManualPlannerItem } from "@/db/queries/items";
import { createReminderPolicyIfMissing } from "@/db/queries/reminderPolicies";
import { snoozeReminder } from "@/db/queries/reminders";
import { plannerItems, reminderPolicies, reminders } from "@/db/schema";

import { materializeNextPolicyReminder } from "./reminderPolicyEngine";

export async function runV242SnoozeProductionProbe(params: {
  userId: string;
  timezone: string;
}) {
  const now = new Date();
  const anchor = new Date(now);
  anchor.setUTCSeconds(0, 0);
  anchor.setUTCMinutes(anchor.getUTCMinutes() - 1);
  const endsAt = new Date(anchor.getTime() + 40 * 60 * 1000);
  let itemId: string | null = null;

  try {
    const item = await createManualPlannerItem({
      userId: params.userId,
      kind: "task",
      title: "V2.4.2 production snooze grid probe",
      timezone: params.timezone,
      dueAt: endsAt,
      metadata: { isTest: true, source: "v242_snooze_probe" },
    });
    itemId = item.id;
    const policy = await createReminderPolicyIfMissing({
      userId: params.userId,
      itemId: item.id,
      title: item.title,
      category: "project",
      policyType: "interval_window",
      timezone: params.timezone,
      startsAt: anchor,
      endsAt,
      nextFireAt: anchor,
      intervalMinutes: 10,
      requireAck: false,
      windowEndInclusive: true,
      catchUpMode: "one_immediate_then_resume",
      onWindowEnd: "expire_silently",
      quietHours: { allowDuringQuietHours: true },
      idempotencyKey: `v242-snooze-probe:${item.id}`,
      metadata: {
        isTest: true,
        source: "v242_snooze_probe",
        allowDuringQuietHours: true,
      },
    });
    const initial = await materializeNextPolicyReminder(policy, anchor, { now: anchor });
    if (!initial) throw new Error("Initial probe reminder was not created");

    const snoozed = await snoozeReminder({
      userId: params.userId,
      reminderId: initial.id,
      minutes: 13,
    });
    if (!snoozed) throw new Error("Probe snooze was rejected");

    const [updatedPolicy, rows] = await Promise.all([
      getDb()
        .select()
        .from(reminderPolicies)
        .where(eq(reminderPolicies.id, policy.id))
        .then((result) => result[0]),
      getDb()
        .select()
        .from(reminders)
        .where(and(eq(reminders.userId, params.userId), eq(reminders.plannerItemId, item.id)))
        .orderBy(asc(reminders.scheduledAt)),
    ]);
    const nextRegularAt = updatedPolicy?.nextFireAt ?? null;
    const gridOffsetMinutes = nextRegularAt
      ? (nextRegularAt.getTime() - anchor.getTime()) / 60_000
      : null;

    return {
      anchor,
      intervalMinutes: 10,
      snoozeMinutes: 13,
      snoozeAt: snoozed.scheduledAt,
      nextRegularAt,
      nextRegularGridOffsetMinutes: gridOffsetMinutes,
      gridPreserved: gridOffsetMinutes !== null && gridOffsetMinutes % 10 === 0,
      reminders: rows.map((reminder) => ({
        purpose: reminder.purpose,
        status: reminder.status,
        scheduledAt: reminder.scheduledAt,
        policyId: reminder.policyId,
      })),
    };
  } finally {
    if (itemId) {
      await getDb().delete(plannerItems).where(eq(plannerItems.id, itemId));
    }
  }
}
