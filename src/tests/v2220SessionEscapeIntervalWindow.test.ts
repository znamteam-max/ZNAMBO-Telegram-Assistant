import { describe, expect, it, vi, beforeEach } from "vitest";

import type { PlannerItem, Reminder, ReminderPolicy } from "@/db/schema";
import { localIsoToUtcDate } from "@/domain/dateTime";
import { parseStandaloneIntervalWindowReminderIntent } from "@/domain/intervalWindowReminderIntent";
import { formatDashboardItem } from "@/telegram/liveDashboard";

const mocks = vi.hoisted(() => ({
  proposeAgentExecution: vi.fn(),
  clearActiveInteractionSessionsWithDetails: vi.fn(),
  createIntervalWindowReminderFromIntent: vi.fn(),
  formatIntervalWindowCreationReply: vi.fn(),
  replyAndRecord: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/bot/context", () => ({
  requireOwner: () => ({ id: userId, timezone }),
}));

vi.mock("@/ai/agentExecution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ai/agentExecution")>();
  return { ...actual, proposeAgentExecution: mocks.proposeAgentExecution };
});

vi.mock("@/bot/sessionRouting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/bot/sessionRouting")>();
  return {
    ...actual,
    clearActiveInteractionSessionsWithDetails: mocks.clearActiveInteractionSessionsWithDetails,
  };
});

vi.mock("@/services/intervalWindowReminderCreation", () => ({
  createIntervalWindowReminderFromIntent: mocks.createIntervalWindowReminderFromIntent,
  formatIntervalWindowCreationReply: mocks.formatIntervalWindowCreationReply,
}));

vi.mock("@/bot/reply", () => ({
  replyAndRecord: mocks.replyAndRecord,
}));

vi.mock("@/db/queries/audit", () => ({
  writeAudit: mocks.writeAudit,
}));

import { handleJarvisTurn } from "@/agent/jarvisPipeline";
import type { BotContext } from "@/bot/context";

const timezone = "Europe/Moscow";
const userId = "22222222-2222-4222-8222-222222222222";
const itemId = "11111111-1111-4111-8111-111111111111";
const policyId = "33333333-3333-4333-8333-333333333333";
const reminderId = "44444444-4444-4444-8444-444444444444";
const exactPhrase =
  "Завтра с 6 до 7.30 напоминай мне каждые 10 минут взять с собой спицы";
const now = new Date("2026-06-17T10:00:00.000Z");

describe("V2.22.0 session escape and interval-window reminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.replyAndRecord.mockResolvedValue(undefined);
    mocks.clearActiveInteractionSessionsWithDetails.mockResolvedValue([]);
    mocks.createIntervalWindowReminderFromIntent.mockResolvedValue({
      item: plannerItem({
        id: itemId,
        title: "Взять с собой спицы",
        startAt: localIsoToUtcDate("2026-06-18T06:00:00", timezone),
        dueAt: localIsoToUtcDate("2026-06-18T07:30:00", timezone),
      }),
      policy: reminderPolicy({
        id: policyId,
        startsAt: localIsoToUtcDate("2026-06-18T06:00:00", timezone),
        endsAt: localIsoToUtcDate("2026-06-18T07:30:00", timezone),
        nextFireAt: localIsoToUtcDate("2026-06-18T06:00:00", timezone),
      }),
      reminder: reminder({ id: reminderId }),
    });
    mocks.formatIntervalWindowCreationReply.mockReturnValue(
      "Добавил:\nЗавтра 06:00–07:30 · Взять с собой спицы",
    );
  });

  it.each([
    "Завтра с 6 до 7.30 напоминай каждые 10 минут взять спицы",
    "завтра с 06:00 до 07:30 напоминай мне каждые 10 минут взять с собой спицы",
    "с 6 до 7:30 завтра пинай каждые 10 минут взять спицы",
    "завтра утром с 6 до 7.30 каждые 10 минут напомни про спицы",
  ])("parses standalone interval-window reminder intent: %s", (text) => {
    const intent = parseStandaloneIntervalWindowReminderIntent({ text, timezone, now });

    expect(intent).toEqual(
      expect.objectContaining({
        intent: "create_interval_window_reminder",
        dateLocal: "2026-06-18",
        windowStartLocal: "06:00",
        windowEndLocal: "07:30",
        intervalMinutes: 10,
        timezone,
      }),
    );
    expect(intent?.title.toLocaleLowerCase("ru")).toContain("спиц");
  });

  it("treats 6 to 7.30 as a morning window, not evening", () => {
    const intent = parseStandaloneIntervalWindowReminderIntent({
      text: exactPhrase,
      timezone,
      now,
    });

    expect(intent?.startsAtLocalIso).toBe("2026-06-18T06:00:00");
    expect(intent?.endsAtLocalIso).toBe("2026-06-18T07:30:00");
  });

  it("creates a new interval-window reminder without an active session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await handleJarvisTurn(ctx(), exactPhrase, timezone);

    expect(mocks.proposeAgentExecution).not.toHaveBeenCalled();
    expect(mocks.clearActiveInteractionSessionsWithDetails).toHaveBeenCalledOnce();
    expect(mocks.createIntervalWindowReminderFromIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        sourceMessageId: "message-id",
        intent: expect.objectContaining({
          title: "Взять с собой спицы",
          windowStartLocal: "06:00",
          windowEndLocal: "07:30",
          intervalMinutes: 10,
        }),
      }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assistant.agent_decision_trace",
        details: expect.objectContaining({
          finalAction: "created_interval_window_reminder",
          aiCalled: false,
          createdItemIds: [itemId],
          createdPolicyIds: [policyId],
          createdReminderIds: [reminderId],
        }),
      }),
    );
  });

  it("escapes an unrelated active recurring-card session before creation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.clearActiveInteractionSessionsWithDetails.mockResolvedValue([
      {
        type: "reminder_policy_edit_session",
        actionId: "session-id",
        itemId: "ecp-item-id",
      },
    ]);

    await handleJarvisTurn(ctx(), exactPhrase, timezone);

    expect(mocks.proposeAgentExecution).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assistant.session_escape_to_new_intent",
        details: expect.objectContaining({
          escapedSessionType: "reminder_policy_edit_session",
          escapedItemId: "ecp-item-id",
          escapedActionId: "session-id",
          newIntent: "create_interval_window_reminder",
          reason: "standalone_date_window_cadence_and_object",
          timezone,
        }),
      }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assistant.agent_decision_trace",
        details: expect.objectContaining({
          sessionRouting: expect.objectContaining({
            escaped: true,
            newIntent: "create_interval_window_reminder",
          }),
          finalAction: "created_interval_window_reminder",
        }),
      }),
    );
  });

  it("renders finite interval-window reminders as dated tasks, not long-term rules", () => {
    const item = plannerItem({
      title: "Взять с собой спицы",
      startAt: localIsoToUtcDate("2026-06-18T06:00:00", timezone),
      dueAt: localIsoToUtcDate("2026-06-18T07:30:00", timezone),
    });
    const policy = reminderPolicy({
      itemId: item.id,
      startsAt: localIsoToUtcDate("2026-06-18T06:00:00", timezone),
      endsAt: localIsoToUtcDate("2026-06-18T07:30:00", timezone),
      nextFireAt: localIsoToUtcDate("2026-06-18T06:00:00", timezone),
      intervalMinutes: 10,
      metadata: { activeWindowStart: "06:00", activeWindowEnd: "07:30", finiteWindow: true },
    });

    const text = formatDashboardItem(item, timezone, null, true, [policy], [], now);

    expect(text).toContain("Взять с собой спицы");
    expect(text).toContain("06:00");
    expect(text).toContain("07:30");
    expect(text).toContain("каждые 10 мин");
    expect(text).not.toContain("↻");
    expect(text.match(/⏰|🗓/g)?.length).toBeLessThanOrEqual(1);
  });
});

function ctx(): BotContext {
  return {
    dbMessageId: "message-id",
    update: { update_id: 1001 },
  } as BotContext;
}

function plannerItem(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: itemId,
    userId,
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Задача",
    description: null,
    location: null,
    timezone,
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "reminder",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: new Date("2026-06-17T07:00:00.000Z"),
    updatedAt: new Date("2026-06-17T07:00:00.000Z"),
    ...overrides,
  };
}

function reminderPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: policyId,
    userId,
    itemId,
    title: "Взять с собой спицы",
    category: "interval_window",
    policyType: "interval_window",
    status: "active",
    timezone,
    startsAt: null,
    endsAt: null,
    nextFireAt: null,
    recurrenceRule: null,
    intervalMinutes: 10,
    requireAck: false,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    snoozedUntil: null,
    snoozeScope: null,
    quietHours: { allowDuringQuietHours: true },
    escalationPolicy: null,
    metadata: {},
    createdAt: new Date("2026-06-17T07:00:00.000Z"),
    updatedAt: new Date("2026-06-17T07:00:00.000Z"),
    ...overrides,
  };
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: reminderId,
    userId,
    plannerItemId: itemId,
    type: "interval_nag",
    idempotencyKey: "test",
    scheduledAt: new Date("2026-06-18T03:00:00.000Z"),
    status: "pending",
    claimedAt: null,
    sentAt: null,
    telegramMessageId: null,
    attemptCount: 0,
    lastError: null,
    repeatUntilAck: false,
    ackedAt: null,
    parentReminderId: null,
    recurrenceKey: null,
    policyId,
    purpose: "interval_nag",
    menuType: "reminder",
    autoDeleteAfterResponse: true,
    supersededByMessageId: null,
    payload: {},
    createdAt: new Date("2026-06-17T07:00:00.000Z"),
    updatedAt: new Date("2026-06-17T07:00:00.000Z"),
    ...overrides,
  };
}
