import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { actionPlanSchema, type ActionPlanItem } from "@/ai/schemas";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import { formatHumanReminderPolicy } from "@/domain/reminderPolicyPresentation";
import { chooseSpacedReminderSlot } from "@/services/reminderCollisionSpacing";
import { buildUserTimelineViewFromData } from "@/services/userTimeline";
import { formatDashboardItem } from "@/telegram/liveDashboard";
import { normalizeTodayUntilDoneTask } from "@/domain/todayUntilDoneTask";
import { collectV2190ProductionRepairCandidates } from "@/services/v2190ProductionRepair";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";

const timezone = "Europe/Moscow";
const userId = "22222222-2222-4222-8222-222222222222";
const itemId = "11111111-1111-4111-8111-111111111111";
const policyId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-06-17T07:35:00.000Z");
const mainText =
  "Напомни мне сегодня проверить билеты на концерт Вадима Постильного, на какое число и так далее. Напоминай мне до тех пор, пока я это не сделаю сегодня.";

describe("V2.19.0 today until-done semantics", () => {
  it("normalizes main text into a today task due at local 23:59 and an until-done policy", () => {
    const normalized = normalizeTodayUntilDoneTask({
      text: mainText,
      timezone,
      now,
      title: "Проверить билеты на концерт Вадима Постильного",
    });

    expect(normalized).toEqual(
      expect.objectContaining({
        title: "Проверить билеты на концерт Вадима Постильного",
        dueAtLocal: "2026-06-17T23:59:00",
        endsAtLocal: "2026-06-17T23:59:00",
        intervalMinutes: 60,
        endOfDayLocal: "23:59",
      }),
    );
    expect(normalized?.metadata).toEqual(
      expect.objectContaining({
        normalization: "today_until_done",
        timeScope: "today",
        untilDone: true,
        stopCondition: "until_done",
      }),
    );
    expect(normalized?.endsAt.toISOString()).toBe("2026-06-17T20:59:00.000Z");
  });

  it("rewrites a weak AI proposal into one task plus one nag-until-ack policy", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: agentExecutionSchema.parse({
        intent: "create_plan",
        reply: null,
        actionPlan: actionPlanSchema.parse({
          intent: "plan",
          summary: "Проверить билеты",
          reply: null,
          confidence: 0.82,
          requiresConfirmation: false,
          actions: [
            action({
              title: "Проверить билеты на концерт Вадима Постильного",
              dueAtLocal: null,
            }),
          ],
          memoryCandidates: [],
          clarificationQuestions: [],
        }),
        viewScope: null,
        resetMode: null,
        itemUpdates: [],
        reminderPolicies: [],
        memoryFacts: [],
        clarificationQuestions: [],
      }),
      text: mainText,
      timezone,
      now,
      activeContext: "none",
    });

    expect(execution.actionPlan?.actions).toEqual([
      expect.objectContaining({
        actionType: "task",
        kind: "task",
        title: "Проверить билеты на концерт Вадима Постильного",
        dueAtLocal: "2026-06-17T23:59:00",
        metadata: expect.objectContaining({
          normalization: "today_until_done",
          itemDueAtLocal: "2026-06-17T23:59:00+03:00",
        }),
      }),
    ]);
    expect(execution.reminderPolicies).toEqual([
      expect.objectContaining({
        operation: "create_interval_window_policy",
        category: "nag_until_done",
        policyType: "nag_until_ack",
        startsAtLocal: "2026-06-17T10:36:00",
        endsAtLocal: "2026-06-17T23:59:00",
        intervalMinutes: 60,
        requireAck: true,
        onWindowEnd: "move_to_overdue_or_review",
      }),
    ]);
  });

  it("supports translit trigger text", () => {
    const normalized = normalizeTodayUntilDoneTask({
      text: "napominay segodnya proverit bilety poka ne sdelayu",
      timezone,
      now,
    });

    expect(normalized?.dueAtLocal).toBe("2026-06-17T23:59:00");
    expect(normalized?.intervalMinutes).toBe(60);
  });

  it("renders local end-of-day as 23:59 and keeps the item in today's task bucket", () => {
    const item = plannerItem({
      kind: "task",
      title: "Проверить билеты на концерт Вадима Постильного",
      dueAt: new Date("2026-06-17T20:59:00.000Z"),
      metadata: {
        normalization: "today_until_done",
        timeScope: "today",
        untilDone: true,
        itemDueAtLocal: "2026-06-17T23:59:00.000+03:00",
      },
    });
    const policy = reminderPolicy({
      itemId: item.id,
      title: item.title,
      policyType: "nag_until_ack",
      category: "nag_until_done",
      startsAt: new Date("2026-06-17T07:36:00.000Z"),
      endsAt: new Date("2026-06-17T20:59:00.000Z"),
      nextFireAt: new Date("2026-06-17T07:36:00.000Z"),
      intervalMinutes: 60,
      requireAck: true,
      onWindowEnd: "move_to_overdue_or_review",
      metadata: {
        normalization: "today_until_done",
        timeScope: "today",
        untilDone: true,
        activeWindowEnd: "23:59",
        stopCondition: "until_done",
      },
    });

    const timeline = buildUserTimelineViewFromData({
      items: [item],
      policies: [policy],
      timezone,
      now,
    });
    const dashboard = formatDashboardItem(item, timezone, null, false, [policy], now);
    const policyText = formatHumanReminderPolicy(policy, timezone, {
      item,
      now,
      includeMarker: false,
    });

    expect(timeline.byBucket.today.map((row) => row.item?.id)).toContain(item.id);
    expect(timeline.byBucket.longTerm.map((row) => row.item?.id)).not.toContain(item.id);
    expect(dashboard).toContain("до 23:59");
    expect(policyText).toContain("каждый час до 23:59");
    expect(`${dashboard}\n${policyText}`).not.toContain("02:59");
    expect(`${dashboard}\n${policyText}`).not.toContain("без времени");
  });

  it("derives a today due date from an attached until-done policy when old data missed item dueAt", () => {
    const item = plannerItem({
      kind: "task",
      title: "Проверить билеты",
      dueAt: null,
      startAt: null,
      metadata: {},
    });
    const policy = reminderPolicy({
      itemId: item.id,
      policyType: "nag_until_ack",
      category: "nag_until_done",
      endsAt: new Date("2026-06-17T20:59:00.000Z"),
      intervalMinutes: 60,
      requireAck: true,
      metadata: {
        normalization: "today_until_done",
        stopCondition: "until_done",
      },
    });

    const timeline = buildUserTimelineViewFromData({
      items: [item],
      policies: [policy],
      timezone,
      now,
    });

    expect(timeline.byBucket.today.map((row) => row.item?.id)).toContain(item.id);
    expect(timeline.byBucket.longTerm.map((row) => row.item?.id)).not.toContain(item.id);
  });

  it("shows policy snooze state without moving the task out of today", () => {
    const policy = reminderPolicy({
      policyType: "nag_until_ack",
      category: "nag_until_done",
      startsAt: new Date("2026-06-17T07:36:00.000Z"),
      endsAt: new Date("2026-06-17T20:59:00.000Z"),
      nextFireAt: new Date("2026-06-17T08:36:00.000Z"),
      snoozedUntil: new Date("2026-06-17T09:35:00.000Z"),
      intervalMinutes: 60,
      requireAck: true,
      metadata: {
        normalization: "today_until_done",
        activeWindowEnd: "23:59",
        stopCondition: "until_done",
      },
    });
    const text = formatHumanReminderPolicy(policy, timezone, {
      now,
      includeMarker: false,
    });

    expect(text).toContain("отложено до 12:35");
    expect(text).toContain("потом каждый час до 23:59");
  });

  it("spaces colliding until-done reminders by five minutes", () => {
    const first = chooseSpacedReminderSlot({
      desiredAt: new Date("2026-06-17T07:36:00.000Z"),
      occupiedSlots: [],
    });
    const second = chooseSpacedReminderSlot({
      desiredAt: new Date("2026-06-17T07:36:00.000Z"),
      occupiedSlots: [first.scheduledAt],
    });

    expect(first.scheduledAt.toISOString()).toBe("2026-06-17T07:36:00.000Z");
    expect(second.scheduledAt.toISOString()).toBe("2026-06-17T07:41:00.000Z");
    expect(second.shiftMinutes).toBe(5);
  });

  it("collects V2.19 repair candidates without touching calendar objects", () => {
    const item = plannerItem({
      dueAt: null,
      startAt: null,
      metadata: {},
    });
    const policy = reminderPolicy({
      itemId: item.id,
      nextFireAt: new Date("2026-06-17T08:36:00.000Z"),
      policyType: "nag_until_ack",
      category: "nag_until_done",
      endsAt: new Date("2026-06-17T20:59:00.000Z"),
      intervalMinutes: 60,
      requireAck: true,
      metadata: {
        normalization: "today_until_done",
        stopCondition: "until_done",
      },
    });

    const candidates = collectV2190ProductionRepairCandidates({
      items: [item],
      policies: [policy],
      pendingPolicyIds: new Set(),
      now,
      timezone,
    });

    expect(candidates.policiesMissingNextReminderIds).toEqual([policy.id]);
    expect(candidates.repairablePolicyIds).toEqual([policy.id]);
    expect(candidates.todayUntilDoneItemIdsMissingDueAt).toEqual([item.id]);
    expect(candidates.calendarObjectsToChange).toBe(0);
    expect(candidates.safeToApply).toBe(true);
  });
});

function action(overrides: Partial<ActionPlanItem> = {}): ActionPlanItem {
  return {
    actionType: "task",
    kind: "task",
    title: "Проверить билеты",
    description: null,
    location: null,
    timezone,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: null,
    durationMinutes: null,
    priority: 3,
    confidence: 0.9,
    risk: "low",
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: {},
    ...overrides,
  };
}

function plannerItem(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: itemId,
    userId,
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Проверить билеты",
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
    title: "Проверить билеты",
    category: "nag_until_done",
    policyType: "nag_until_ack",
    status: "active",
    timezone,
    startsAt: new Date("2026-06-17T07:36:00.000Z"),
    endsAt: new Date("2026-06-17T20:59:00.000Z"),
    nextFireAt: new Date("2026-06-17T07:36:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: 60,
    requireAck: true,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "move_to_overdue_or_review",
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
