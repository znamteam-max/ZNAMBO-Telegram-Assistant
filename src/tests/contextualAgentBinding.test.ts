import { describe, expect, it } from "vitest";

import type { AgentExecution } from "@/ai/schemas/agentExecution";
import { bindContextualCompletionTarget } from "@/services/contextualAgentBinding";

describe("contextual agent binding", () => {
  it("binds a generic completion reply to the latest fresh follow-up item", () => {
    const execution = makeExecution([
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]);

    const result = bindContextualCompletionTarget({
      execution,
      text: "Отлично! Выполнено, поставь это сделанным",
      latestFollowupItemId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.execution.itemUpdates).toEqual([
      expect.objectContaining({
        operation: "complete",
        itemIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    ]);
    expect(result.warnings).toEqual(["contextual_completion_bound_to_latest_followup"]);
  });

  it("does not rewrite a completion when there is no fresh follow-up anchor", () => {
    const execution = makeExecution(["22222222-2222-4222-8222-222222222222"]);

    const result = bindContextualCompletionTarget({
      execution,
      text: "Подготовка выполнена",
      latestFollowupItemId: null,
    });

    expect(result.execution).toBe(execution);
    expect(result.warnings).toEqual([]);
  });
});

function makeExecution(itemIds: string[]): AgentExecution {
  return {
    intent: "update_existing_items",
    reply: "Готово.",
    actionPlan: null,
    viewScope: null,
    resetMode: null,
    itemUpdates: [
      {
        itemIds,
        operation: "complete",
        startAtLocal: null,
        endAtLocal: null,
        reminderMinutesBefore: null,
        followupMinutesAfter: null,
        exposeManagementButtons: false,
        note: null,
      },
    ],
    memoryFacts: [],
    clarificationQuestions: [],
  };
}
