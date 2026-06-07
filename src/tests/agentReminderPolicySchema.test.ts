import { describe, expect, it } from "vitest";

import { agentExecutionTool } from "@/ai/agentExecution";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";

describe("V2.4 agent reminder policy schema", () => {
  it("accepts one interval policy alongside one item plan", () => {
    const parsed = agentExecutionSchema.parse({
      intent: "create_plan",
      reply: "Настроил задачу и повторы.",
      actionPlan: null,
      viewScope: "dashboard",
      resetMode: null,
      itemUpdates: [],
      reminderPolicies: [
        {
          operation: "create_interval_window_policy",
          itemIds: [],
          itemTitle: "Позвонить Дрик по поводу Роба",
          title: "Позвонить Дрик по поводу Роба",
          category: "nag_until_done",
          policyType: "interval_window",
          startsAtLocal: "2026-06-08T08:00:00",
          endsAtLocal: "2026-06-08T14:00:00",
          nextFireAtLocal: "2026-06-08T08:00:00",
          recurrenceRule: null,
          intervalMinutes: 30,
          requireAck: false,
          maxOccurrences: null,
          minutesBefore: null,
        },
      ],
      memoryFacts: [],
      clarificationQuestions: [],
    });

    expect(parsed.reminderPolicies).toHaveLength(1);
    expect(parsed.reminderPolicies[0].intervalMinutes).toBe(30);
  });

  it("requires reminderPolicies in the strict OpenAI tool contract", () => {
    expect(agentExecutionTool.parameters.required).toContain("reminderPolicies");
  });
});
