import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimDueReminders: vi.fn(),
  createReminderIfMissing: vi.fn(),
  markReminderFailed: vi.fn(),
  markReminderSent: vi.fn(),
  recordReminderDelivery: vi.fn(),
  getUserById: vi.fn(),
  listUsers: vi.fn(),
  getPlannerItemByAnyId: vi.fn(),
  listItemsBetween: vi.fn(),
  listOpenTasks: vi.fn(),
}));

vi.mock("@/db/queries/reminders", () => ({
  claimDueReminders: mocks.claimDueReminders,
  createReminderIfMissing: mocks.createReminderIfMissing,
  markReminderFailed: mocks.markReminderFailed,
  markReminderSent: mocks.markReminderSent,
  recordReminderDelivery: mocks.recordReminderDelivery,
}));

vi.mock("@/db/queries/users", () => ({
  getUserById: mocks.getUserById,
  listUsers: mocks.listUsers,
}));

vi.mock("@/db/queries/items", () => ({
  getPlannerItemByAnyId: mocks.getPlannerItemByAnyId,
  listItemsBetween: mocks.listItemsBetween,
  listOpenTasks: mocks.listOpenTasks,
}));

vi.mock("@/bot/createBot", () => ({
  getBot: () => ({ api: { sendMessage: vi.fn() } }),
}));

import { runDueReminders } from "@/jobs/runDueReminders";

describe("runDueReminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listUsers.mockResolvedValue([]);
    mocks.listItemsBetween.mockResolvedValue([]);
    mocks.listOpenTasks.mockResolvedValue([]);
    mocks.getUserById.mockResolvedValue({
      id: "user-id",
      telegramUserId: 52203584n,
      timezone: "Europe/Moscow",
    });
    mocks.getPlannerItemByAnyId.mockResolvedValue({
      id: "item-id",
      kind: "recurring_task",
      title: "Рилзы по F1 и MMA",
      timezone: "Europe/Moscow",
      startAt: null,
      endAt: null,
      dueAt: new Date("2026-06-01T06:30:00.000Z"),
    });
  });

  it("continues an until-ack reminder chain until the daily cutoff", async () => {
    const now = new Date("2026-06-01T08:45:00.000Z");
    const reminder = {
      id: "repeat-reminder-id",
      userId: "user-id",
      plannerItemId: "item-id",
      type: "until_ack",
      scheduledAt: now,
      status: "claimed",
      claimedAt: now,
      sentAt: null,
      telegramMessageId: null,
      attemptCount: 1,
      lastError: null,
      repeatUntilAck: true,
      ackedAt: null,
      parentReminderId: "root-reminder-id",
      recurrenceKey: "weekly:MO,TU,WE,FR:09:30",
      payload: { untilAckRepeat: true },
      createdAt: now,
      updatedAt: now,
    };
    mocks.claimDueReminders.mockResolvedValue([reminder]);
    const sender = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1001 }) };

    await expect(runDueReminders({ now, sender })).resolves.toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
    });

    expect(mocks.createReminderIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-id",
        plannerItemId: "item-id",
        type: "until_ack",
        repeatUntilAck: true,
        parentReminderId: "root-reminder-id",
        recurrenceKey: "weekly:MO,TU,WE,FR:09:30",
        scheduledAt: new Date("2026-06-01T10:00:00.000Z"),
      }),
    );
  });
});
