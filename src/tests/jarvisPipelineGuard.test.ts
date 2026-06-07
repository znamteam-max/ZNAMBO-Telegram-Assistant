import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleIncomingUserMessage: vi.fn(),
  handleHardManagementIntent: vi.fn(),
  replyAndRecord: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/bot/context", () => ({
  requireOwner: () => ({ id: "user-id", timezone: "Europe/Moscow" }),
}));

vi.mock("@/bot/messagePipeline", () => ({
  handleIncomingUserMessage: mocks.handleIncomingUserMessage,
}));

vi.mock("@/agent/hardManagementRouter", () => ({
  handleHardManagementIntent: mocks.handleHardManagementIntent,
}));

vi.mock("@/bot/reply", () => ({
  replyAndRecord: mocks.replyAndRecord,
}));

vi.mock("@/db/queries/audit", () => ({
  writeAudit: mocks.writeAudit,
}));

import { handleJarvisTurn } from "@/agent/jarvisPipeline";
import type { BotContext } from "@/bot/context";

describe("Jarvis hard-management guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleHardManagementIntent.mockResolvedValue({
      intent: "management",
      result: { handled: true, reply: "handled", affectedItemIds: [] },
    });
  });

  it.each([
    "Удали всё, давай заново",
    "Хочу отметить что выполнено вчера",
    "Дай план за последние 2 дня",
    "Удалить 1, 4, 5, 7-10",
  ])("never delegates management text to the legacy planner: %s", async (text) => {
    await handleJarvisTurn({ dbMessageId: "message-id" } as BotContext, text, "Europe/Moscow");

    expect(mocks.handleHardManagementIntent).toHaveBeenCalledOnce();
    expect(mocks.handleIncomingUserMessage).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          fallbackUsed: false,
          createItemAttempted: false,
        }),
      }),
    );
  });
});
