import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import {
  conflictKeyboard,
  itemMenuKeyboard,
  multiReminderConflictKeyboard,
  priorityEditorKeyboard,
  repeatPolicyDeleteKeyboard,
} from "@/bot/keyboards";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { formatDashboardItem } from "@/telegram/liveDashboard";
import {
  computeNextPolicySlotAfterDelivery,
  resolvePolicyReconcileTarget,
} from "@/domain/reminderPolicySchedule";
import {
  formatRecurringClarification,
  parseRecurringPolicyIntents,
} from "@/domain/recurringPolicySemantics";

const timezone = "Europe/Moscow";
const userId = "22222222-2222-4222-8222-222222222222";
const itemId = "11111111-1111-4111-8111-111111111111";
const policyId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-06-17T10:00:00.000Z");

describe("V2.20.0 plan rendering, daily policy and callback safety", () => {
  it("renders compact today reminder lines without repeated bell icons", () => {
    const item = plannerItem({
      kind: "event",
      title: "Отвезти Роба к ортодонту",
      startAt: new Date("2026-06-17T11:20:00.000Z"),
    });
    const text = formatDashboardItem(
      item,
      timezone,
      null,
      false,
      [
        reminderPolicy({
          id: "33333333-3333-4333-8333-333333333331",
          itemId: item.id,
          policyType: "before_event",
          nextFireAt: new Date("2026-06-17T08:20:00.000Z"),
          startsAt: new Date("2026-06-17T08:20:00.000Z"),
          metadata: { minutesBefore: 180 },
        }),
        reminderPolicy({
          id: "33333333-3333-4333-8333-333333333332",
          itemId: item.id,
          policyType: "before_event",
          nextFireAt: new Date("2026-06-17T09:20:00.000Z"),
          startsAt: new Date("2026-06-17T09:20:00.000Z"),
          metadata: { minutesBefore: 120 },
        }),
        reminderPolicy({
          id: "33333333-3333-4333-8333-333333333333",
          itemId: item.id,
          policyType: "before_event",
          nextFireAt: new Date("2026-06-17T10:20:00.000Z"),
          startsAt: new Date("2026-06-17T10:20:00.000Z"),
          metadata: { minutesBefore: 60 },
        }),
      ],
      [],
      now,
    );

    expect(text).toContain("⏰ за 3 ч, за 2 часа, за час");
    expect(text).not.toContain("🔔");
    expect(text.match(/⏰/g)).toHaveLength(1);
  });

  it("materializes a skipped current monthly day-range occurrence", () => {
    const policy = reminderPolicy({
      policyType: "recurring",
      recurrenceRule: "monthly_days:15,16,17,18,19@12:00",
      nextFireAt: new Date("2026-06-18T09:00:00.000Z"),
    });
    const target = resolvePolicyReconcileTarget(policy, now);

    expect(target).toEqual({
      scheduledFor: new Date("2026-06-17T09:00:00.000Z"),
      deliveryAt: now,
      catchUp: true,
    });
  });

  it("advances monthly day-range ack to the next configured day, not next month", () => {
    const next = computeNextPolicySlotAfterDelivery({
      policy: reminderPolicy({
        policyType: "recurring",
        recurrenceRule: "monthly_days:15,16,17,18,19@12:00",
      }),
      scheduledFor: new Date("2026-06-16T09:00:00.000Z"),
      now: new Date("2026-06-16T09:01:00.000Z"),
    });

    expect(next).toEqual(new Date("2026-06-17T09:00:00.000Z"));
  });

  it("keeps a snoozed monthly occurrence paused instead of recreating it", () => {
    const policy = reminderPolicy({
      policyType: "recurring",
      recurrenceRule: "monthly_days:15,16,17,18,19@12:00",
      nextFireAt: new Date("2026-06-17T09:00:00.000Z"),
      snoozedUntil: new Date("2026-06-17T10:30:00.000Z"),
    });

    expect(resolvePolicyReconcileTarget(policy, now)).toBeNull();
  });

  it("creates a daily recurring missing-time draft candidate", () => {
    const [intent] = parseRecurringPolicyIntents("Каждый день напоминай мне решить вопрос с ЭЦП");

    expect(intent).toEqual(
      expect.objectContaining({
        title: "Решить вопрос с ЭЦП",
        recurrenceRule: "daily",
        recurrenceKind: "daily",
        missingFields: ["reminderTime"],
      }),
    );
    expect(formatRecurringClarification([intent])).toContain("Во сколько каждый день");
  });

  it("normalizes today reminder text to end-of-day due without invented +1h deadline", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text: "Напомни мне сегодня решить вопрос с ЭЦП",
      timezone,
      now,
      activeContext: "none",
    });

    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({
        title: "Решить вопрос с ЭЦП",
        dueAtLocal: "2026-06-17T23:59:00",
        reminders: [],
        metadata: expect.objectContaining({
          sourceNormalization: "today_task_due_v2200",
          todayTaskDueNormalized: true,
        }),
      }),
    );
  });

  it("keeps generated callback payloads within Telegram's 64-byte limit", () => {
    const item = plannerItem();
    const keyboards = [
      multiReminderConflictKeyboard(item.id),
      conflictKeyboard(item.id, "44444444-4444-4444-8444-444444444444"),
      repeatPolicyDeleteKeyboard(policyId, item.id),
      priorityEditorKeyboard("item", item.id),
      itemMenuKeyboard(item.id, null, null, false, [
        reminderPolicy({ id: policyId, itemId: item.id }),
        reminderPolicy({ id: "55555555-5555-4555-8555-555555555555", itemId: item.id }),
      ]),
    ];

    for (const keyboard of keyboards) {
      for (const button of (keyboard as { inline_keyboard: Array<Array<{ callback_data?: string }>> })
        .inline_keyboard.flat()) {
        if (!button.callback_data) continue;
        expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });
});

function emptyExecution() {
  return agentExecutionSchema.parse({
    intent: "clarify",
    reply: null,
    actionPlan: null,
    viewScope: null,
    resetMode: null,
    itemUpdates: [],
    reminderPolicies: [],
    memoryFacts: [],
    clarificationQuestions: [],
  });
}

function plannerItem(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: itemId,
    userId,
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Решить вопрос с ЭЦП",
    description: null,
    location: null,
    timezone,
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "task",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: new Date("2026-06-17T07:00:00.000Z"),
    updatedAt: new Date("2026-06-17T07:00:00.000Z"),
    ...overrides,
  };
}

function reminderPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: policyId,
    userId,
    itemId,
    title: "Решить вопрос с ЭЦП",
    category: "pre_event",
    policyType: "before_event",
    status: "active",
    timezone,
    startsAt: new Date("2026-06-17T09:00:00.000Z"),
    endsAt: null,
    nextFireAt: new Date("2026-06-17T09:00:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: null,
    requireAck: false,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    snoozedUntil: null,
    snoozeScope: null,
    quietHours: null,
    escalationPolicy: null,
    metadata: {},
    createdAt: new Date("2026-06-17T07:00:00.000Z"),
    updatedAt: new Date("2026-06-17T07:00:00.000Z"),
    ...overrides,
  };
}
