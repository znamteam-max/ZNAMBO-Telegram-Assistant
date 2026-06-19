import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import type { PlannerItem, Reminder, ReminderPolicy } from "@/db/schema";
import { formatRuWeekdayDateRange, localIsoToUtcDate } from "@/domain/dateTime";
import {
  formatBeforeEventOffset,
  formatEventFollowupReminderLines,
} from "@/domain/reminderPolicyPresentation";
import { formatDashboardItem } from "@/telegram/liveDashboard";

const timezone = "Europe/Moscow";
const userId = "22222222-2222-4222-8222-222222222222";
const itemId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-06-17T10:00:00.000Z");

describe("V2.21.0 owner timezone, visual plan and multi-event reminders", () => {
  it("stores Friday 21:30 Moscow as UTC and renders 21:30, not 18:30", () => {
    const stored = localIsoToUtcDate("2026-06-19T21:30:00", timezone);
    expect(stored.toISOString()).toBe("2026-06-19T18:30:00.000Z");
    expect(
      formatRuWeekdayDateRange(stored, new Date("2026-06-19T19:30:00.000Z"), timezone),
    ).toContain("21:30");
  });

  it("renders one compact visual reminder line and visible event follow-up", () => {
    const item = plannerItem({
      kind: "event",
      title: "Отвезти Роба к ортодонту",
      startAt: new Date("2026-06-17T11:20:00.000Z"),
      endAt: new Date("2026-06-17T12:20:00.000Z"),
    });
    const text = formatDashboardItem(
      item,
      timezone,
      null,
      false,
      [
        reminderPolicy({
          itemId: item.id,
          policyType: "before_event",
          nextFireAt: new Date("2026-06-17T10:20:00.000Z"),
          startsAt: new Date("2026-06-17T10:20:00.000Z"),
          metadata: { minutesBefore: 60 },
        }),
      ],
      [
        reminder({
          plannerItemId: item.id,
          scheduledAt: new Date("2026-06-17T10:50:00.000Z"),
          purpose: "pre_event_extra",
          payload: { eventReminderOnly: true },
        }),
      ],
      now,
    );

    expect(text).toContain("⏰ за час; доп. напоминание 13:50");
    expect(text.match(/⏰/g)).toHaveLength(1);
    expect(formatEventFollowupReminderLines([reminder()], timezone, { item, now })).toContain(
      "доп. напоминание 13:50",
    );
  });

  it("uses human labels for week/day before-event offsets", () => {
    expect(formatBeforeEventOffset(10080)).toBe("за неделю");
    expect(formatBeforeEventOffset(4320)).toBe("за 3 дня");
    expect(formatBeforeEventOffset(2880)).toBe("за 2 дня");
  });

  it("normalizes orthodontist multi-event reminder template per event", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text: "Повторные два прихода с Робом к ортодонту сначала 1 июля в 19.00 и 2 июля в 11.45, напомни про пару этих визитов за неделю, за 3 дня, за 2 дня, и утром в эти дни много раз",
      timezone,
      now,
      activeContext: "none",
    });

    expect(execution.actionPlan?.actions).toHaveLength(2);
    expect(execution.actionPlan?.actions.map((action) => action.startAtLocal)).toEqual([
      "2026-07-01T19:00:00",
      "2026-07-02T11:45:00",
    ]);
    expect(execution.actionPlan?.actions.every((action) => action.reminders.length === 5)).toBe(
      true,
    );
    const labels = execution.actionPlan?.actions.flatMap((action) =>
      action.reminders.map((entry) => entry.payload.relativeLabel),
    );
    expect(labels).toContain("за неделю");
    expect(labels).toContain("за 3 дня");
    expect(labels).toContain("за 2 часа");
    expect(labels).toContain("за 30 минут");
    expect(labels).toContain("утром в день визита");
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
    kind: "event",
    status: "active",
    title: "Событие",
    description: null,
    location: null,
    timezone,
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "event",
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
    id: "33333333-3333-4333-8333-333333333333",
    userId,
    itemId,
    title: "Напоминание",
    category: "pre_event",
    policyType: "before_event",
    status: "active",
    timezone,
    startsAt: new Date("2026-06-17T10:20:00.000Z"),
    endsAt: null,
    nextFireAt: new Date("2026-06-17T10:20:00.000Z"),
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

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    userId,
    plannerItemId: itemId,
    type: "event_before",
    idempotencyKey: "test",
    scheduledAt: new Date("2026-06-17T10:50:00.000Z"),
    status: "pending",
    claimedAt: null,
    sentAt: null,
    telegramMessageId: null,
    attemptCount: 0,
    lastError: null,
    repeatUntilAck: false,
    ackedAt: null,
    parentReminderId: null,
    recurrenceKey: null,
    policyId: null,
    purpose: "pre_event_extra",
    menuType: "event_reminder",
    autoDeleteAfterResponse: true,
    supersededByMessageId: null,
    payload: { eventReminderOnly: true },
    createdAt: new Date("2026-06-17T07:00:00.000Z"),
    updatedAt: new Date("2026-06-17T07:00:00.000Z"),
    ...overrides,
  };
}
