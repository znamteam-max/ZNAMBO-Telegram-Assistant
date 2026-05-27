import { describe, expect, it, vi } from "vitest";

import { recordTelegramUpdate } from "@/db/queries/messages";
import { recordUpdateOnce } from "@/bot/updateRecorder";
import type { BotContext } from "@/bot/context";

vi.mock("@/db/queries/messages", () => ({
  recordTelegramUpdate: vi.fn(),
}));

describe("webhook update idempotency", () => {
  it("stops duplicate Telegram updates before handlers run", async () => {
    vi.mocked(recordTelegramUpdate).mockResolvedValueOnce(null);
    const next = vi.fn();
    await recordUpdateOnce(
      {
        update: { update_id: 100 },
        from: { id: 42 },
        chat: { id: 42 },
        message: { message_id: 10, text: "hello" },
      } as unknown as BotContext,
      next,
    );

    expect(next).not.toHaveBeenCalled();
  });

  it("passes first-time updates and stores db message id on context", async () => {
    vi.mocked(recordTelegramUpdate).mockResolvedValueOnce("message-1");
    const next = vi.fn();
    const ctx = {
      update: { update_id: 101 },
      from: { id: 42 },
      chat: { id: 42 },
      message: { message_id: 11, text: "hello" },
    } as unknown as BotContext;

    await recordUpdateOnce(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.dbMessageId).toBe("message-1");
  });
});
