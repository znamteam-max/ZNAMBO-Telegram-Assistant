import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@/ai/openaiClient", () => ({
  getOpenAIClient: () => ({ responses: { create: mocks.create } }),
}));

import {
  MandatoryAiError,
  agentExecutionTool,
  proposeAgentExecution,
} from "@/ai/agentExecution";

describe("mandatory OpenAI agent execution proposal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies the real daily list as two events and one training with exact start times", async () => {
    mocks.create.mockResolvedValue(
      responseFor({
        intent: "create_plan",
        reply: "Собрал три события.",
        actionPlan: {
          intent: "plan",
          summary: "Три пункта на сегодня",
          reply: null,
          confidence: 0.96,
          requiresConfirmation: false,
          actions: [
            action("event", "event", "Красочный забег", "2026-06-07T10:00:00"),
            action("event", "event", "Эфир ВС", "2026-06-07T13:00:00"),
            action("training", "training", "Тренировка Z2", "2026-06-07T22:00:00"),
          ],
          memoryCandidates: [],
          clarificationQuestions: [],
        },
        viewScope: null,
        resetMode: null,
        itemUpdates: [],
        memoryFacts: [],
        clarificationQuestions: [],
      }),
    );

    const result = await proposeAgentExecution({
      text: "На сегодня:\n* красочный забег в 10:00\n* эфир ВС в 13:00\n* тренировка Z2 в 22:00",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T05:00:00.000Z"),
      activeContext: "none",
    });

    expect(result.execution.actionPlan?.actions.map((item) => item.kind)).toEqual([
      "event",
      "event",
      "training",
    ]);
    expect(result.execution.actionPlan?.actions.map((item) => item.startAtLocal)).toEqual([
      "2026-06-07T10:00:00",
      "2026-06-07T13:00:00",
      "2026-06-07T22:00:00",
    ]);
    expect(result.execution.actionPlan?.actions.every((item) => item.dueAtLocal === null)).toBe(true);
    expect(mocks.create.mock.calls[0]?.[0]?.instructions).toContain(
      "Не выбирай render_today для такого сообщения.",
    );
    expect(mocks.create.mock.calls[0]?.[0]?.instructions).toContain(
      "Выбирай ровно один primary mutation path.",
    );
    expect(result.telemetry).toEqual(
      expect.objectContaining({
        aiCalled: true,
        aiSucceeded: true,
        openaiResponseId: "resp_test",
        structuredOutputValid: true,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        toolCallsProposed: ["create_action_plan"],
      }),
    );
  });

  it("updates referenced items instead of creating a generic instruction task", async () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    mocks.create.mockResolvedValue(
      responseFor({
        intent: "update_existing_items",
        reply: "Добавлю напоминания и follow-up.",
        actionPlan: null,
        viewScope: null,
        resetMode: null,
        itemUpdates: [
          {
            itemIds: ids,
            operation: "configure",
            startAtLocal: null,
            endAtLocal: null,
            reminderMinutesBefore: 60,
            followupMinutesAfter: 15,
            exposeManagementButtons: true,
            note: "Apply to every event from the current plan.",
          },
        ],
        memoryFacts: [],
        clarificationQuestions: [],
      }),
    );

    const result = await proposeAgentExecution({
      text: "Напомни мне за час до каждого события, а после спроси как прошло, дай кнопки по удалению, переносу, редактированию каждого события отдельно",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T05:00:00.000Z"),
      activeContext: ids.map((id) => `id=${id}`).join("\n"),
    });

    expect(result.execution.actionPlan).toBeNull();
    expect(result.execution.itemUpdates[0]).toEqual(
      expect.objectContaining({
        itemIds: ids,
        reminderMinutesBefore: 60,
        followupMinutesAfter: 15,
        exposeManagementButtons: true,
      }),
    );
    expect(result.telemetry.toolCallsProposed).toEqual(["update_existing_items"]);
  });

  it("normalizes a valid but semantically weak AI proposal after the mandatory model call", async () => {
    mocks.create.mockResolvedValue(
      responseFor({
        intent: "clarify",
        reply: "Уточни период.",
        actionPlan: null,
        viewScope: null,
        resetMode: null,
        itemUpdates: [],
        reminderPolicies: [],
        memoryFacts: [],
        clarificationQuestions: ["Уточни период."],
      }),
    );

    const result = await proposeAgentExecution({
      text: "раз в неделю напоминать про замену зеркала в машине, раз в две недели про ЖКХ",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T08:00:00.000Z"),
      activeContext: "none",
    });

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(result.execution.intent).toBe("manage_reminder_policies");
    expect(result.execution.reminderPolicies.map((policy) => policy.recurrenceRule)).toEqual([
      "weekly",
      "every_2_weeks",
    ]);
    expect(result.telemetry.toolCallsProposed).toEqual(["create_recurring_policy"]);
  });

  it("normalizes the complex three-reminder request through the real OpenAI proposal path", async () => {
    mocks.create.mockResolvedValue(
      responseFor({
        intent: "clarify",
        reply: "Уточни.",
        actionPlan: null,
        viewScope: null,
        resetMode: null,
        itemUpdates: [],
        reminderPolicies: [],
        memoryFacts: [],
        clarificationQuestions: ["Уточни."],
      }),
    );

    const result = await proposeAgentExecution({
      text: "Три напоминания: напоминай каждый понедельник весь день раз в час решить вопрос с зеркалом для машины, с 20-го числа каждый день об оплате квартиры, а 17-18-19 июня каждый час внести показания счётчиков. Каждый месяц с 15 по 19 число давай такие напоминания.",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-13T13:43:00.000Z"),
      activeContext: "none",
    });

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(result.execution.actionPlan?.requiresConfirmation).toBe(true);
    expect(result.execution.actionPlan?.actions).toHaveLength(3);
    expect(result.telemetry.aiCalled).toBe(true);
    expect(result.telemetry.toolCallsProposed).toEqual(["create_action_plan"]);
  });

  it("fails closed when OpenAI fails", async () => {
    mocks.create.mockRejectedValue(new Error("network down"));

    await expect(
      proposeAgentExecution({
        text: "создай задачу",
        timezone: "Europe/Moscow",
        now: new Date(),
        activeContext: "none",
      }),
    ).rejects.toBeInstanceOf(MandatoryAiError);
  });

  it("retries one stochastic structured-output failure and aggregates usage", async () => {
    mocks.create
      .mockResolvedValueOnce({
        ...responseFor({ invalid: true }),
        id: "resp_invalid",
      })
      .mockResolvedValueOnce(
        responseFor({
          intent: "reply",
          reply: "Готово.",
          actionPlan: null,
          viewScope: null,
          resetMode: null,
          itemUpdates: [],
          memoryFacts: [],
          clarificationQuestions: [],
        }),
      );

    const result = await proposeAgentExecution({
      text: "Ответь коротко",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T05:00:00.000Z"),
      activeContext: "none",
    });

    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(result.telemetry).toEqual(
      expect.objectContaining({
        aiSucceeded: true,
        openaiResponseId: "resp_test",
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
      }),
    );
  });

  it("uses a fully strict function schema for production agent output", () => {
    const actionPlan = agentExecutionTool.parameters.properties.actionPlan.anyOf[1];
    const actionItem = actionPlan.properties.actions.items;

    expect(agentExecutionTool.strict).toBe(true);
    expect(actionItem.properties.metadata.additionalProperties).toBe(false);
    expect(actionItem.properties.reminders.items.properties.payload.additionalProperties).toBe(false);
  });

  it("completes only the item from the latest delivered follow-up", async () => {
    const itemId = "11111111-1111-4111-8111-111111111111";
    mocks.create.mockResolvedValue(
      responseFor({
        intent: "update_existing_items",
        reply: "Отмечу забег выполненным.",
        actionPlan: null,
        viewScope: null,
        resetMode: null,
        itemUpdates: [
          {
            itemIds: [itemId],
            operation: "complete",
            startAtLocal: null,
            endAtLocal: null,
            reminderMinutesBefore: null,
            followupMinutesAfter: null,
            exposeManagementButtons: false,
            note: "Completion reply to the latest delivered follow-up.",
          },
        ],
        memoryFacts: [],
        clarificationQuestions: [],
      }),
    );

    const result = await proposeAgentExecution({
      text: "Отлично! Выполнено, поставь это сделанным",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T10:09:00.000Z"),
      activeContext: `Latest delivered reminder/follow-up:\n- itemId=${itemId}; title=Красочный забег`,
    });

    expect(result.execution.itemUpdates).toEqual([
      expect.objectContaining({
        itemIds: [itemId],
        operation: "complete",
      }),
    ]);
  });

  it("creates only the new preparation and requests a post-execution today view", async () => {
    mocks.create.mockResolvedValue(
      responseFor({
        intent: "create_plan",
        reply: "Добавлю подготовку и покажу итоговый план.",
        actionPlan: {
          intent: "plan",
          summary: "Подготовка к ЧМ вечером",
          reply: null,
          confidence: 0.95,
          requiresConfirmation: false,
          actions: [
            {
              ...action(
                "preparation",
                "preparation_task",
                "Подготовка к ЧМ",
                "2026-06-07T21:00:00",
              ),
              location: "дома",
            },
          ],
          memoryCandidates: [],
          clarificationQuestions: [],
        },
        viewScope: "today",
        resetMode: null,
        itemUpdates: [],
        memoryFacts: [],
        clarificationQuestions: [],
      }),
    );

    const result = await proposeAgentExecution({
      text: "Дай план на сегодня, добавь вечером подготовку к ЧМ дома",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T10:25:00.000Z"),
      activeContext: "Today:\n- Эфир ВС\n- Тренировка Z2",
    });

    expect(result.execution.viewScope).toBe("today");
    expect(result.execution.actionPlan?.actions.map((item) => item.title)).toEqual([
      "Подготовка к ЧМ",
    ]);
  });

  it("proposes one reschedule operation for an event time range", async () => {
    const itemId = "22222222-2222-4222-8222-222222222222";
    mocks.create.mockResolvedValue(
      responseFor({
        intent: "update_existing_items",
        reply: "Продлил эфир до 20:00.",
        actionPlan: null,
        viewScope: null,
        resetMode: null,
        itemUpdates: [
          {
            itemIds: [itemId],
            operation: "reschedule",
            startAtLocal: "2026-06-07T13:00:00",
            endAtLocal: "2026-06-07T20:00:00",
            reminderMinutesBefore: null,
            followupMinutesAfter: null,
            exposeManagementButtons: true,
            note: null,
          },
        ],
        memoryFacts: [],
        clarificationQuestions: [],
      }),
    );

    const result = await proposeAgentExecution({
      text: "Эфир ВС с 13 до 20 сделай",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T10:27:00.000Z"),
      activeContext: `Today:\n- id=${itemId}; 2026-06-07 13:00: event Эфир ВС`,
    });

    expect(result.execution.itemUpdates).toEqual([
      expect.objectContaining({
        itemIds: [itemId],
        operation: "reschedule",
        startAtLocal: "2026-06-07T13:00:00",
        endAtLocal: "2026-06-07T20:00:00",
      }),
    ]);
  });
});

function responseFor(argumentsValue: Record<string, unknown>) {
  return {
    id: "resp_test",
    model: "gpt-4o-mini-2024-07-18",
    output: [
      {
        type: "function_call",
        name: "propose_agent_execution",
        arguments: JSON.stringify(argumentsValue),
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  };
}

function action(
  actionType: "event" | "training" | "preparation",
  kind: "event" | "training" | "preparation_task",
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
    durationMinutes: 60,
    priority: 3,
    confidence: 0.96,
    risk: "low",
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: {},
  };
}
