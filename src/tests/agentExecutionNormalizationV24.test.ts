import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import {
  agentExecutionSchema,
  type AgentReminderPolicy,
} from "@/ai/schemas/agentExecution";

const now = new Date("2026-06-07T08:00:00.000Z");

describe("V2.4 post-AI reminder policy normalization", () => {
  it("turns the production interval phrase into one task and one interval-window policy", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: agentExecutionSchema.parse({
        intent: "create_plan",
        reply: "Настрою повтор.",
        actionPlan: {
          intent: "plan",
          summary: "Кружок",
          reply: null,
          confidence: 0.9,
          requiresConfirmation: false,
          actions: [
            action("note", "note", "Кружок с анонсом винбокса", "2026-06-08T08:00:00"),
          ],
          memoryCandidates: [],
          clarificationQuestions: [],
        },
        viewScope: null,
        resetMode: null,
        itemUpdates: [],
        reminderPolicies: [
          policy({
            operation: "create_recurring_policy",
            policyType: "recurring",
            title: "Кружок с анонсом винбокса",
            intervalMinutes: 30,
            recurrenceRule: "every_30_minutes",
          }),
        ],
        memoryFacts: [],
        clarificationQuestions: [],
      }),
      text: "Записать кружок с анонсом винбокса завтра до 11.00, повторять с 8.00 утра каждые полчаса, пока не отмечу",
      timezone: "Europe/Moscow",
      now,
      activeContext: "none",
    });

    expect(execution.actionPlan?.actions).toHaveLength(1);
    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({
        actionType: "task",
        kind: "task",
        title: "Записать кружок с анонсом винбокса",
        startAtLocal: null,
        dueAtLocal: "2026-06-08T11:00:00",
      }),
    );
    expect(execution.reminderPolicies).toEqual([
      expect.objectContaining({
        operation: "create_interval_window_policy",
        policyType: "interval_window",
        startsAtLocal: "2026-06-08T08:00:00",
        endsAtLocal: "2026-06-08T11:00:00",
        intervalMinutes: 30,
        requireAck: true,
      }),
    ]);
  });

  it("turns weekly and biweekly clarify output into two long-term policies", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text: "раз в неделю напоминать про замену зеркала в машине, раз в две недели про ЖКХ",
      timezone: "Europe/Moscow",
      now,
      activeContext: "none",
    });

    expect(execution.intent).toBe("manage_reminder_policies");
    expect(execution.reminderPolicies).toEqual([
      expect.objectContaining({
        category: "recurring_car",
        recurrenceRule: "weekly",
        requireAck: true,
      }),
      expect.objectContaining({
        category: "recurring_finance",
        recurrenceRule: "every_2_weeks",
        requireAck: true,
      }),
    ]);
  });

  it("binds before/post configuration to current event IDs instead of leaving clarify", () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text: "Напомни мне за час до каждого события, а после дай меню реакции с переносом, отменой, итогами, редактированием и удалением",
      timezone: "Europe/Moscow",
      now,
      activeContext: [
        `- id=${ids[0]}; 2026-06-07 10:00: event Красочный забег`,
        `- id=${ids[1]}; 2026-06-07 13:00: event Эфир ВС`,
        `- id=${ids[2]}; 2026-06-07 22:00: training Тренировка Z2`,
      ].join("\n"),
    });

    expect(execution.intent).toBe("update_existing_items");
    expect(execution.actionPlan).toBeNull();
    expect(execution.itemUpdates).toEqual([
      expect.objectContaining({
        itemIds: ids,
        operation: "configure",
        reminderMinutesBefore: 60,
        followupMinutesAfter: 0,
        exposeManagementButtons: true,
      }),
    ]);
  });
});

function emptyExecution() {
  return agentExecutionSchema.parse({
    intent: "clarify",
    reply: "Уточни.",
    actionPlan: null,
    viewScope: null,
    resetMode: null,
    itemUpdates: [],
    reminderPolicies: [],
    memoryFacts: [],
    clarificationQuestions: ["Уточни."],
  });
}

function policy(overrides: Partial<AgentReminderPolicy> = {}): AgentReminderPolicy {
  return {
    operation: "create_recurring_policy",
    itemIds: [],
    itemTitle: null,
    title: "Напоминание",
    category: "long_term",
    policyType: "long_term",
    startsAtLocal: null,
    endsAtLocal: null,
    nextFireAtLocal: null,
    recurrenceRule: null,
    intervalMinutes: null,
    requireAck: false,
    maxOccurrences: null,
    minutesBefore: null,
    ...overrides,
  };
}

function action(
  actionType: "note",
  kind: "note",
  title: string,
  startAtLocal: string,
) {
  return {
    actionType,
    kind,
    title,
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAtLocal,
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
  };
}
