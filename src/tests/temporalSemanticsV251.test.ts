import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { validateReminderPoliciesBeforeSave } from "@/ai/antiGarbageValidator";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";

describe("V2.5.1 night temporal semantics", () => {
  it("keeps an NBA 03:30 event and explicit 01:30/02:00 reminders in the upcoming night", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: eventExecution("2026-06-10T15:30:00"),
      text: "Сегодня матч Финала НБА: Spurs vs Knicks в 3.30, мне нужны напоминания в 1.30 и 2.00, чтобы я выехал в бар",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-10T16:08:00.000Z"),
      activeContext: "none",
    });

    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({
        startAtLocal: "2026-06-11T03:30:00",
        priority: 4,
      }),
    );
    expect(execution.actionPlan?.actions[0]?.reminders.map((value) => value.scheduledAtLocal)).toEqual([
      "2026-06-11T01:30:00",
      "2026-06-11T02:00:00",
    ]);
  });

  it("repairs an existing NBA event instead of proposing a delete", () => {
    const itemId = "11111111-1111-4111-8111-111111111111";
    const execution = normalizeAgentExecutionProposal({
      execution: agentExecutionSchema.parse({
        ...emptyExecution(),
        intent: "reply",
      }),
      text: "Матч в 3.30 ночью, а не в 15.30. Исправь его",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-10T16:08:00.000Z"),
      activeContext: `- id=${itemId}; 2026-06-11 15:30: event Матч Финала НБА`,
    });

    expect(execution.intent).toBe("update_existing_items");
    expect(execution.itemUpdates).toEqual([
      expect.objectContaining({
        itemIds: [itemId],
        operation: "reschedule",
        startAtLocal: "2026-06-11T03:30:00",
      }),
    ]);
    expect(execution.reminderPolicies).toEqual([]);
  });

  it("blocks a reminder request when explicit reminder times disappeared", () => {
    const execution = eventExecution("2026-06-11T03:30:00");
    const validation = validateReminderPoliciesBeforeSave({
      plan: execution.actionPlan!,
      policies: [],
      timezone: "Europe/Moscow",
      originalMessage: "Матч НБА в 3.30, напомни в 1.30 и 2.00",
    });

    expect(validation.ok).toBe(false);
    expect(validation.warnings).toContain("explicit reminder times are not fully materialized");
  });

  it("parses explicit priority five", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: eventExecution("2026-06-11T15:00:00"),
      text: "Завтра встреча в Winline в 15:00. Приоритет 5.",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-10T10:00:00.000Z"),
      activeContext: "none",
    });
    expect(execution.actionPlan?.actions[0]?.priority).toBe(5);
  });

  it("updates an existing item's priority from natural language", () => {
    const itemId = "11111111-1111-4111-8111-111111111111";
    const execution = normalizeAgentExecutionProposal({
      execution: agentExecutionSchema.parse(emptyExecution()),
      text: "Сделай Дрик приоритетом 4",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-10T10:00:00.000Z"),
      activeContext: `- id=${itemId}; status=active; task Записаться к Дрик`,
    });
    expect(execution.itemUpdates).toEqual([
      expect.objectContaining({ itemIds: [itemId], operation: "configure", priority: 4 }),
    ]);
  });
});

function eventExecution(startAtLocal: string) {
  return agentExecutionSchema.parse({
    ...emptyExecution(),
    intent: "create_plan",
    actionPlan: {
      intent: "plan",
      summary: "Матч",
      reply: null,
      confidence: 0.95,
      requiresConfirmation: false,
      actions: [
        {
          actionType: "event",
          kind: "event",
          title: "Матч Финала НБА",
          description: null,
          location: null,
          timezone: "Europe/Moscow",
          startAtLocal,
          endAtLocal: null,
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
