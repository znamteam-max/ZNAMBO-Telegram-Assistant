import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveDashboard: vi.fn(),
  createActiveDashboard: vi.fn(),
  markDashboardStatus: vi.fn(),
  listRecentRangeItems: vi.fn(),
  listActiveReminderPolicies: vi.fn(),
  listLongTermReminderPolicies: vi.fn(),
  listLegacyReminderLikeItems: vi.fn(),
  registerBotMessage: vi.fn(),
  deleteMessageSafe: vi.fn(),
  removeKeyboardSafe: vi.fn(),
}));

vi.mock("@/db/queries/liveDashboards", () => ({
  getActiveDashboard: mocks.getActiveDashboard,
  createActiveDashboard: mocks.createActiveDashboard,
  markDashboardStatus: mocks.markDashboardStatus,
}));
vi.mock("@/db/queries/items", () => ({
  listRecentRangeItems: mocks.listRecentRangeItems,
  listLegacyReminderLikeItems: mocks.listLegacyReminderLikeItems,
}));
vi.mock("@/db/queries/reminderPolicies", () => ({
  listActiveReminderPolicies: mocks.listActiveReminderPolicies,
  listLongTermReminderPolicies: mocks.listLongTermReminderPolicies,
}));
vi.mock("@/telegram/messageLifecycle", () => ({
  registerBotMessage: mocks.registerBotMessage,
  deleteMessageSafe: mocks.deleteMessageSafe,
  removeKeyboardSafe: mocks.removeKeyboardSafe,
}));
vi.mock("@/bot/createBot", () => ({
  getBot: () => ({ api: {} }),
}));

import {
  renderReminderPolicyList,
  sendOrRefreshLiveDashboard,
} from "@/telegram/liveDashboard";

describe("live dashboard lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getActiveDashboard.mockResolvedValue({
      id: "old-dashboard",
      messageId: 10,
    });
    mocks.deleteMessageSafe.mockResolvedValue(true);
    mocks.createActiveDashboard.mockResolvedValue({ id: "new-dashboard" });
    mocks.listRecentRangeItems.mockResolvedValue([
      {
        id: "event-id",
        status: "active",
        kind: "event",
        title: "Эфир ВС",
        timezone: "Europe/Moscow",
        startAt: new Date("2026-06-07T10:00:00.000Z"),
        endAt: new Date("2026-06-07T17:00:00.000Z"),
        dueAt: null,
      },
    ]);
    mocks.listActiveReminderPolicies.mockResolvedValue([]);
    mocks.listLongTermReminderPolicies.mockResolvedValue([]);
    mocks.listLegacyReminderLikeItems.mockResolvedValue([]);
  });

  it("retires the previous dashboard and leaves exactly one new active dashboard", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      deleteMessage: vi.fn(),
      editMessageReplyMarkup: vi.fn(),
    };

    const result = await sendOrRefreshLiveDashboard({
      userId: "user-id",
      chatId: "42",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T08:00:00.000Z"),
      api,
    });

    expect(mocks.deleteMessageSafe).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "42", messageId: 10 }),
    );
    expect(mocks.markDashboardStatus).toHaveBeenCalledWith("old-dashboard", "deleted");
    expect(api.sendMessage).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("Эфир ВС"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(mocks.createActiveDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 11 }),
    );
    expect(mocks.registerBotMessage).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "dashboard", messageId: 11 }),
    );
    expect(result.items).toHaveLength(1);
  });

  it("reports legacy reminder-like notes instead of claiming reminders are empty", async () => {
    mocks.listActiveReminderPolicies.mockResolvedValue([]);
    mocks.listLegacyReminderLikeItems.mockResolvedValue([
      {
        id: "legacy-id",
        title: "Регулярное напоминание по ЖКХ",
        visibility: "active",
      },
    ]);

    const text = await renderReminderPolicyList({
      userId: "user-id",
      timezone: "Europe/Moscow",
    });

    expect(text).toContain("Активные политики: 0");
    expect(text).toContain("старых записей");
    expect(text).toContain("Регулярное напоминание по ЖКХ");
    expect(text).toContain("без policy");
  });
});
