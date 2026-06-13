import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshDashboardAfterMutation: vi.fn(),
}));

vi.mock("@/telegram/liveDashboard", () => ({
  refreshDashboardAfterMutation: mocks.refreshDashboardAfterMutation,
}));

import { registerCommands } from "@/bot/commands";

type CommandContext = {
  owner: { id: string; timezone: string };
  chat: { id: number };
  reply: ReturnType<typeof vi.fn>;
};

describe("V2.8.0 Plan command routing", () => {
  const handlers = new Map<string, (ctx: CommandContext) => Promise<unknown>>();

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    const bot = {
      command(name: string, handler: (ctx: CommandContext) => Promise<unknown>) {
        handlers.set(name, handler);
      },
    };
    registerCommands(bot as never);
    mocks.refreshDashboardAfterMutation.mockResolvedValue({ text: "JARVIS · План" });
  });

  for (const command of ["plan", "dashboard"]) {
    it(`renders Plan directly for /${command}`, async () => {
      const ctx: CommandContext = {
        owner: { id: "user-id", timezone: "Europe/Moscow" },
        chat: { id: 52203584 },
        reply: vi.fn(),
      };

      await handlers.get(command)!(ctx);

      expect(mocks.refreshDashboardAfterMutation).toHaveBeenCalledWith({
        userId: "user-id",
        chatId: 52203584,
        timezone: "Europe/Moscow",
      });
      expect(ctx.reply).not.toHaveBeenCalledWith(
        "Навигация",
        expect.anything(),
      );
    });
  }
});
