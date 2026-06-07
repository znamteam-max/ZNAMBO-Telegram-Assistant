import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listActiveMessages: vi.fn(),
  markTelegramMessageStatus: vi.fn(),
  registerTelegramBotMessage: vi.fn(),
}));

vi.mock("@/db/queries/telegramMessageRegistry", () => ({
  listActiveMessages: mocks.listActiveMessages,
  markTelegramMessageStatus: mocks.markTelegramMessageStatus,
  registerTelegramBotMessage: mocks.registerTelegramBotMessage,
}));
vi.mock("@/bot/createBot", () => ({
  getBot: () => ({ api: {} }),
}));

import { deleteMessageSafe } from "@/telegram/messageLifecycle";

describe("Telegram message lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("disables a stale action card when Telegram refuses deletion", async () => {
    const api = {
      deleteMessage: vi.fn().mockRejectedValue(new Error("message can't be deleted")),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    };

    await expect(
      deleteMessageSafe({ chatId: "42", messageId: 100, api }),
    ).resolves.toBe(false);

    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith("42", 100, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(mocks.markTelegramMessageStatus).toHaveBeenCalledWith(
      "42",
      100,
      "failed_to_delete",
    );
  });
});
