import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proposeAgentExecution: vi.fn(),
  handleHardManagementIntent: vi.fn(),
  replyAndRecord: vi.fn(),
  writeAudit: vi.fn(),
  buildJarvisContext: vi.fn(),
}));

vi.mock("@/bot/context", () => ({
  requireOwner: () => ({ id: "user-id", timezone: "Europe/Moscow" }),
}));

vi.mock("@/ai/agentExecution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ai/agentExecution")>();
  return { ...actual, proposeAgentExecution: mocks.proposeAgentExecution };
});

vi.mock("@/agent/hardManagementRouter", () => ({
  handleHardManagementIntent: mocks.handleHardManagementIntent,
}));

vi.mock("@/agent/context/buildJarvisContext", () => ({
  buildJarvisContext: mocks.buildJarvisContext,
}));

vi.mock("@/bot/reply", () => ({
  replyAndRecord: mocks.replyAndRecord,
}));

vi.mock("@/db/queries/audit", () => ({
  writeAudit: mocks.writeAudit,
}));

import { handleJarvisTurn } from "@/agent/jarvisPipeline";
import type { BotContext } from "@/bot/context";

describe("Jarvis mandatory AI guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildJarvisContext.mockResolvedValue({
      activeContext: "context",
      contextError: null,
      lastTaskViewState: null,
      latestFollowupItemId: null,
      latestFollowupDeliveredAt: null,
    });
    mocks.proposeAgentExecution.mockResolvedValue({
      execution: {
        intent: "clarify",
        reply: "Уточни",
        actionPlan: null,
        viewScope: null,
        resetMode: null,
        itemUpdates: [],
        memoryFacts: [],
        clarificationQuestions: [],
      },
      telemetry: {
        aiRequired: true,
        aiCalled: true,
        aiSucceeded: true,
        aiModel: "gpt-4o-mini",
        openaiResponseId: "resp_test",
        requestStartedAt: "2026-06-07T09:00:00.000Z",
        requestFinishedAt: "2026-06-07T09:00:00.100Z",
        latencyMs: 100,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        structuredOutputValid: true,
        toolCallsProposed: ["clarify"],
        errorCode: null,
        safeErrorMessage: null,
      },
    });
    mocks.handleHardManagementIntent.mockResolvedValue({
      intent: "delete_by_indices",
      result: { handled: true, reply: "handled", affectedItemIds: [] },
    });
  });

  it.each([
    "Удали всё, давай заново",
    "Хочу отметить что выполнено вчера",
    "Дай план за последние 2 дня",
  ])("requires AI for natural-language management: %s", async (text) => {
    await handleJarvisTurn({ dbMessageId: "message-id" } as BotContext, text, "Europe/Moscow");

    expect(mocks.proposeAgentExecution).toHaveBeenCalledOnce();
    expect(mocks.handleHardManagementIntent).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          aiRequired: true,
          aiCalled: true,
          aiSucceeded: true,
          fallbackUsed: false,
        }),
      }),
    );
  });

  it("allows direct index deletion without AI after a saved task view", async () => {
    await handleJarvisTurn(
      { dbMessageId: "message-id" } as BotContext,
      "Удалить 1, 4, 5, 7-10",
      "Europe/Moscow",
    );

    expect(mocks.proposeAgentExecution).not.toHaveBeenCalled();
    expect(mocks.handleHardManagementIntent).toHaveBeenCalledOnce();
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          aiRequired: false,
          aiCalled: false,
          fallbackUsed: false,
        }),
      }),
    );
  });
});
