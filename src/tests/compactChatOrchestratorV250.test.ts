import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listActiveMessages: vi.fn(),
  deleteMessagesSafe: vi.fn(),
  registerBotMessage: vi.fn(),
  sendOrRefreshLiveDashboard: vi.fn(),
}));

vi.mock("@/db/queries/telegramMessageRegistry", () => ({
  listActiveMessages: mocks.listActiveMessages,
}));
vi.mock("@/telegram/messageLifecycle", () => ({
  deleteMessagesSafe: mocks.deleteMessagesSafe,
  registerBotMessage: mocks.registerBotMessage,
}));
vi.mock("@/telegram/liveDashboard", () => ({
  sendOrRefreshLiveDashboard: mocks.sendOrRefreshLiveDashboard,
}));

import { syncCompactChat } from "@/telegram/compactChatOrchestrator";

describe("compact chat orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listActiveMessages.mockResolvedValue([
      { messageId: 10, purpose: "active_reminder" },
      { messageId: 11, purpose: "reminder" },
    ]);
    mocks.deleteMessagesSafe.mockResolvedValue([true, true]);
    mocks.sendOrRefreshLiveDashboard.mockResolvedValue({ dashboard: { id: "dashboard" } });
  });

  it("keeps one active reminder and sends dashboard before it", async () => {
    const order: string[] = [];
    mocks.sendOrRefreshLiveDashboard.mockImplementation(async () => {
      order.push("dashboard");
      return { dashboard: { id: "dashboard" } };
    });
    const api = {
      sendMessage: vi.fn().mockImplementation(async () => {
        order.push("reminder");
        return { message_id: 12 };
      }),
      deleteMessage: vi.fn(),
      editMessageReplyMarkup: vi.fn(),
    };

    await syncCompactChat({
      userId: "user",
      chatId: "42",
      timezone: "Europe/Moscow",
      reason: "reminder_delivery",
      activeReminder: {
        text: "Reminder",
        relatedItemId: "item",
        relatedReminderId: "reminder",
      },
      api,
    });

    expect(mocks.deleteMessagesSafe).toHaveBeenCalledWith(
      expect.objectContaining({ messageIds: [10, 11] }),
    );
    expect(order).toEqual(["dashboard", "reminder"]);
    expect(mocks.registerBotMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 12,
        purpose: "active_reminder",
        relatedReminderId: "reminder",
      }),
    );
  });
});
