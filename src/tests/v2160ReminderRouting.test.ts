import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { validateReminderPoliciesBeforeSave } from "@/ai/antiGarbageValidator";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import { formatCommittedPlanSummary } from "@/bot/formatters";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { parseBeforeEventReminderSpecsForAnchor } from "@/domain/beforeEventReminderParsing";
import { classifyTimelineItem } from "@/domain/timelineClassification";
import { isStandaloneReminderSnapshotItem } from "@/services/dailyHistory";
import { isV2160FakeReminderEventTitle } from "@/services/v2160ProductionRepair";

const timezone = "Europe/Moscow";

describe("V2.16.0 reminder routing and feedback", () => {
  it("parses bare absolute times as before-event reminders inside setup flow", () => {
    const parsed = parseBeforeEventReminderSpecsForAnchor({
      text: "В 7.00 и 7.30",
      anchor: new Date("2026-06-17T07:00:00.000Z"),
      timezone,
      now: new Date("2026-06-17T02:30:00.000Z"),
      allowAbsoluteTimes: true,
    });

    expect(parsed.reminders.map((reminder) => reminder.fireAtLocal)).toEqual([
      "2026-06-17T07:00:00",
      "2026-06-17T07:30:00",
    ]);
    expect(parsed.reminders.map((reminder) => reminder.minutesBefore)).toEqual([180, 150]);
    expect(parsed.pastLabels).toEqual([]);
  });

  it("does not create past absolute reminders for an event that already passed those times", () => {
    const parsed = parseBeforeEventReminderSpecsForAnchor({
      text: "В 7.00 и 7.30",
      anchor: new Date("2026-06-17T07:00:00.000Z"),
      timezone,
      now: new Date("2026-06-17T05:00:00.000Z"),
      allowAbsoluteTimes: true,
    });

    expect(parsed.reminders).toEqual([]);
    expect(parsed.pastLabels).toEqual(["в 07:00", "в 07:30"]);
  });

  it("turns same-message event reminders into attached before-event policies", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: eventExecution("2026-06-17T15:00:00"),
      text: "Завтра встреча Winline ЦП в 15:00, напомни за два часа и за полчаса",
      timezone,
      now: new Date("2026-06-16T10:00:00.000Z"),
      activeContext: "none",
    });

    expect(execution.reminderPolicies).toEqual([
      expect.objectContaining({
        policyType: "before_event",
        itemTitle: "Встреча Winline ЦП",
        nextFireAtLocal: "2026-06-17T13:00:00",
        minutesBefore: 120,
      }),
      expect.objectContaining({
        policyType: "before_event",
        itemTitle: "Встреча Winline ЦП",
        nextFireAtLocal: "2026-06-17T14:30:00",
        minutesBefore: 30,
      }),
    ]);
    expect(execution.actionPlan?.actions.map((action) => action.title)).not.toContain(
      expect.stringContaining("Напоминание"),
    );
    expect(
      validateReminderPoliciesBeforeSave({
        plan: execution.actionPlan!,
        policies: execution.reminderPolicies,
        timezone,
        originalMessage: "Завтра встреча Winline ЦП в 15:00, напомни за два часа и за полчаса",
      }).ok,
    ).toBe(true);
  });

  it("renders policy-created reminders in the committed local summary", () => {
    const summary = formatCommittedPlanSummary({
      items: [plannerItem()],
      reminderCount: 1,
      reminderPolicies: [
        reminderPolicy({
          metadata: { minutesBefore: 120, relativeLabel: "за 2 часа" },
        }),
      ],
      timezone,
    });

    expect(summary).toContain("Напоминаний создано: 1.");
    expect(summary).toContain("Напоминания:");
    expect(summary).toContain("за 2 часа");
  });

  it("classifies ended event-like items as history even when they were important today", () => {
    expect(
      classifyTimelineItem(
        {
          item: plannerItem({
            kind: "event",
            priority: 5,
            startAt: new Date("2026-06-16T06:00:00.000Z"),
            endAt: new Date("2026-06-16T07:00:00.000Z"),
            metadata: { important: true },
          }),
        },
        new Date("2026-06-16T08:00:00.000Z"),
        timezone,
      ),
    ).toBe("history");
  });

  it("keeps fake standalone reminder rows out of history snapshots and repair previews", () => {
    expect(
      isStandaloneReminderSnapshotItem({
        title: "Напоминание за два часа",
        kind: "event",
        metadata: {},
      }),
    ).toBe(true);
    expect(isV2160FakeReminderEventTitle("Напоминание за 30 минут")).toBe(true);
    expect(
      isStandaloneReminderSnapshotItem({
        title: "Встреча Winline ЦП",
        kind: "event",
        metadata: {},
      }),
    ).toBe(false);
  });
});

function eventExecution(startAtLocal: string) {
  return agentExecutionSchema.parse({
    ...emptyExecution(),
    intent: "create_plan",
    actionPlan: {
      intent: "plan",
      summary: "Встреча Winline ЦП",
      reply: null,
      confidence: 0.95,
      requiresConfirmation: false,
      actions: [
        {
          actionType: "event",
          kind: "event",
          title: "Встреча Winline ЦП",
          description: null,
          location: null,
          timezone,
          startAtLocal,
          endAtLocal: DateTime.fromISO(startAtLocal, { zone: timezone })
            .plus({ hours: 1 })
            .toFormat("yyyy-MM-dd'T'HH:mm:ss"),
          dueAtLocal: null,
          durationMinutes: null,
          priority: 3,
          confidence: 0.95,
          risk: "low",
          requiresConfirmation: false,
          tentative: false,
          recurrence: null,
          reminders: [],
          memoryCandidates: [],
          metadata: {},
        },
      ],
      memoryCandidates: [],
      clarificationQuestions: [],
    },
  });
}

function emptyExecution() {
  return {
    intent: "clarify",
    reply: "Уточни.",
    actionPlan: null,
    viewScope: null,
    resetMode: null,
    itemUpdates: [],
    reminderPolicies: [],
    memoryFacts: [],
    clarificationQuestions: [],
  };
}

function plannerItem(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: "item",
    userId: "user",
    pendingActionId: null,
    kind: "event",
    status: "active",
    title: "Встреча Winline ЦП",
    description: null,
    location: null,
    timezone,
    startAt: new Date("2026-06-17T12:00:00.000Z"),
    endAt: new Date("2026-06-17T13:00:00.000Z"),
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
    createdAt: new Date("2026-06-16T10:00:00.000Z"),
    updatedAt: new Date("2026-06-16T10:00:00.000Z"),
    ...overrides,
  };
}

function reminderPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: "policy",
    userId: "user",
    itemId: "item",
    title: "Встреча Winline ЦП",
    category: "pre_event",
    policyType: "before_event",
    status: "active",
    timezone,
    startsAt: new Date("2026-06-17T10:00:00.000Z"),
    endsAt: null,
    nextFireAt: new Date("2026-06-17T10:00:00.000Z"),
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
    createdAt: new Date("2026-06-16T10:00:00.000Z"),
    updatedAt: new Date("2026-06-16T10:00:00.000Z"),
    ...overrides,
  };
}
