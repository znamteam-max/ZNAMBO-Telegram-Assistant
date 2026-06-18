import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimDueReminders: vi.fn(),
  createReminderIfMissing: vi.fn(),
  isReminderStillDeliverable: vi.fn(),
  markReminderFailed: vi.fn(),
  markReminderSent: vi.fn(),
  recordReminderDelivery: vi.fn(),
  archiveDeliveredTestItem: vi.fn(),
  getUserById: vi.fn(),
  listUsers: vi.fn(),
  getPlannerItemByAnyId: vi.fn(),
  listDailyDigestItems: vi.fn(),
  listEveningReviewItems: vi.fn(),
  listYesterdayCarryCandidates: vi.fn(),
  reconcileActiveReminderPolicies: vi.fn(),
  recordRunnerStarted: vi.fn(),
  recordPolicyReconcile: vi.fn(),
  recordRunnerFinished: vi.fn(),
  acquireRuntimeLease: vi.fn(),
  releaseRuntimeLease: vi.fn(),
  recordPendingPromptRenag: vi.fn(),
  runDuePendingPromptRenags: vi.fn(),
}));

vi.mock("@/db/queries/reminders", () => ({
  claimDueReminders: mocks.claimDueReminders,
  createReminderIfMissing: mocks.createReminderIfMissing,
  isReminderStillDeliverable: mocks.isReminderStillDeliverable,
  markReminderFailed: mocks.markReminderFailed,
  markReminderSent: mocks.markReminderSent,
  recordReminderDelivery: mocks.recordReminderDelivery,
  archiveDeliveredTestItem: mocks.archiveDeliveredTestItem,
}));

vi.mock("@/db/queries/users", () => ({
  getUserById: mocks.getUserById,
  listUsers: mocks.listUsers,
}));

vi.mock("@/db/queries/items", () => ({
  getPlannerItemByAnyId: mocks.getPlannerItemByAnyId,
  listDailyDigestItems: mocks.listDailyDigestItems,
  listEveningReviewItems: mocks.listEveningReviewItems,
  listYesterdayCarryCandidates: mocks.listYesterdayCarryCandidates,
}));

vi.mock("@/bot/createBot", () => ({
  getBot: () => ({ api: { sendMessage: vi.fn() } }),
}));
vi.mock("@/services/reminderPolicyReconciler", () => ({
  reconcileActiveReminderPolicies: mocks.reconcileActiveReminderPolicies,
}));
vi.mock("@/db/queries/schedulerHealth", () => ({
  recordRunnerStarted: mocks.recordRunnerStarted,
  recordPolicyReconcile: mocks.recordPolicyReconcile,
  recordRunnerFinished: mocks.recordRunnerFinished,
}));
vi.mock("@/db/queries/runtimeLocks", () => ({
  acquireRuntimeLease: mocks.acquireRuntimeLease,
  releaseRuntimeLease: mocks.releaseRuntimeLease,
}));
vi.mock("@/services/pendingPromptRenag", () => ({
  recordPendingPromptRenag: mocks.recordPendingPromptRenag,
  runDuePendingPromptRenags: mocks.runDuePendingPromptRenags,
}));

vi.mock("@/agent/state/taskViewState", () => ({
  rememberTaskView: vi.fn().mockResolvedValue({ id: "digest-view-id" }),
}));

import { runDueReminders } from "@/jobs/runDueReminders";

describe("runDueReminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listUsers.mockResolvedValue([]);
    mocks.listDailyDigestItems.mockResolvedValue([]);
    mocks.listEveningReviewItems.mockResolvedValue([]);
    mocks.listYesterdayCarryCandidates.mockResolvedValue([]);
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
    mocks.reconcileActiveReminderPolicies.mockResolvedValue({
      checked: 0,
      materialized: 0,
      advanced: 0,
      expired: 0,
    });
    mocks.recordRunnerStarted.mockResolvedValue(undefined);
    mocks.recordPolicyReconcile.mockResolvedValue(undefined);
    mocks.recordRunnerFinished.mockResolvedValue(undefined);
    mocks.isReminderStillDeliverable.mockResolvedValue(true);
    mocks.acquireRuntimeLease.mockResolvedValue({
      key: "reminder_runner",
      ownerToken: "lease-owner",
      lockedUntil: new Date("2026-06-01T08:46:00.000Z"),
    });
    mocks.releaseRuntimeLease.mockResolvedValue({ key: "reminder_runner" });
    mocks.recordPendingPromptRenag.mockResolvedValue({ id: "pending-prompt-id" });
    mocks.runDuePendingPromptRenags.mockResolvedValue({ checked: 0, sent: 0, cancelled: 0 });
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

  it("includes only the bounded previous-day carry block in morning digest", async () => {
    const now = new Date("2026-06-01T05:00:00.000Z");
    const reminder = {
      id: "morning-digest-id",
      userId: "user-id",
      plannerItemId: null,
      type: "morning_digest",
      scheduledAt: now,
      status: "claimed",
      claimedAt: now,
      sentAt: null,
      telegramMessageId: null,
      attemptCount: 1,
      lastError: null,
      repeatUntilAck: false,
      ackedAt: null,
      parentReminderId: null,
      recurrenceKey: null,
      payload: {},
      createdAt: now,
      updatedAt: now,
    };
    mocks.claimDueReminders.mockResolvedValue([reminder]);
    mocks.listDailyDigestItems.mockResolvedValue([]);
    mocks.listYesterdayCarryCandidates.mockResolvedValue([
      {
        id: "overdue-id",
        kind: "task",
        title: "old open task",
        timezone: "Europe/Moscow",
        startAt: null,
        endAt: null,
        dueAt: new Date("2026-05-31T18:00:00.000Z"),
        metadata: {},
      },
    ]);
    const sender = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1002 }) };

    await runDueReminders({ now, sender });

    expect(sender.sendMessage).toHaveBeenCalledWith(
      "52203584",
      expect.stringContaining("old open task"),
    );
  });

  it("auto-archives a delivered remindertest item without scheduling repeats", async () => {
    const now = new Date("2026-06-01T08:45:00.000Z");
    const reminder = {
      id: "remindertest-id",
      userId: "user-id",
      plannerItemId: "test-item-id",
      type: "custom",
      scheduledAt: now,
      status: "claimed",
      claimedAt: now,
      sentAt: null,
      telegramMessageId: null,
      attemptCount: 1,
      lastError: null,
      repeatUntilAck: false,
      ackedAt: null,
      parentReminderId: null,
      recurrenceKey: null,
      payload: { isTest: true, source: "remindertest" },
      createdAt: now,
      updatedAt: now,
    };
    mocks.claimDueReminders.mockResolvedValue([reminder]);
    mocks.getPlannerItemByAnyId.mockResolvedValue({
      id: "test-item-id",
      kind: "task",
      title: "Test reminder",
      timezone: "Europe/Moscow",
      startAt: null,
      endAt: null,
      dueAt: now,
      metadata: { isTest: true, source: "remindertest" },
    });
    const sender = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1003 }) };

    await runDueReminders({ now, sender });

    expect(mocks.archiveDeliveredTestItem).toHaveBeenCalledWith("user-id", "test-item-id");
    expect(mocks.createReminderIfMissing).not.toHaveBeenCalled();
  });

  it("includes per-item management buttons on configured follow-ups", async () => {
    const now = new Date("2026-06-07T09:45:00.000Z");
    const reminder = {
      id: "followup-id",
      userId: "user-id",
      plannerItemId: "item-id",
      type: "followup",
      scheduledAt: now,
      status: "claimed",
      claimedAt: now,
      sentAt: null,
      telegramMessageId: null,
      attemptCount: 1,
      lastError: null,
      repeatUntilAck: false,
      ackedAt: null,
      parentReminderId: null,
      recurrenceKey: null,
      payload: { title: "Красочный забег" },
      createdAt: now,
      updatedAt: now,
    };
    mocks.claimDueReminders.mockResolvedValue([reminder]);
    mocks.getPlannerItemByAnyId.mockResolvedValue({
      id: "item-id",
      kind: "event",
      title: "Красочный забег",
      timezone: "Europe/Moscow",
      startAt: new Date("2026-06-07T07:00:00.000Z"),
      endAt: new Date("2026-06-07T08:00:00.000Z"),
      dueAt: null,
      metadata: { managementButtonsRequested: true },
    });
    const sender = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1004 }) };

    await runDueReminders({ now, sender });

    expect(sender.sendMessage).toHaveBeenCalledWith(
      "52203584",
      "Событие «Красочный забег» завершилось. Что делаем?",
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    const keyboard = sender.sendMessage.mock.calls[0]?.[2]?.reply_markup as {
      inline_keyboard: Array<Array<{ text: string }>>;
    };
    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toContain("📝 Итоги");
    expect(mocks.recordPendingPromptRenag).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-id",
        promptType: "post_event_menu",
        targetReminderId: "followup-id",
        targetItemId: "item-id",
        text: expect.stringContaining("Красочный забег"),
      }),
    );
  });

  it("does not send a reminder that was snoozed after the runner claimed it", async () => {
    const now = new Date("2026-06-15T07:15:00.000Z");
    const reminder = {
      id: "claimed-before-snooze-id",
      userId: "user-id",
      plannerItemId: "item-id",
      policyId: "policy-id",
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
      parentReminderId: null,
      recurrenceKey: null,
      payload: {},
      createdAt: now,
      updatedAt: now,
    };
    mocks.claimDueReminders.mockResolvedValue([reminder]);
    mocks.isReminderStillDeliverable.mockResolvedValue(false);
    const sender = { sendMessage: vi.fn() };

    await expect(runDueReminders({ now, sender })).resolves.toEqual({
      claimed: 1,
      sent: 0,
      failed: 0,
    });

    expect(sender.sendMessage).not.toHaveBeenCalled();
    expect(mocks.markReminderSent).not.toHaveBeenCalled();
    expect(mocks.recordReminderDelivery).not.toHaveBeenCalled();
  });

  it("skips a concurrent runner when the distributed lease is already active", async () => {
    const now = new Date("2026-06-09T08:00:00.000Z");
    mocks.acquireRuntimeLease
      .mockResolvedValueOnce({
        key: "reminder_runner",
        ownerToken: "first",
        lockedUntil: new Date("2026-06-09T08:00:55.000Z"),
      })
      .mockResolvedValueOnce(null);
    mocks.claimDueReminders.mockResolvedValue([]);
    const sender = { sendMessage: vi.fn() };

    const [first, second] = await Promise.all([
      runDueReminders({ now, sender }),
      runDueReminders({ now, sender }),
    ]);

    expect(first).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(second).toEqual({
      claimed: 0,
      sent: 0,
      failed: 0,
      skipped: true,
      reason: "runner_already_active",
    });
    expect(mocks.claimDueReminders).toHaveBeenCalledTimes(1);
    expect(mocks.releaseRuntimeLease).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileActiveReminderPolicies.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claimDueReminders.mock.invocationCallOrder[0],
    );
  });
});
