import { InlineKeyboard } from "grammy";
import { describe, expect, it, vi } from "vitest";

import { actionableReminderActions, actionableReminderKeyboard } from "@/bot/keyboards";
import { collapseMonthlyAuditSpam } from "@/services/actionLog";
import { parsePinnedContextIntent } from "@/domain/pinnedContextNotes";
import { formatBeforeEventOffset } from "@/domain/reminderPolicyPresentation";
import { renderActionableReminderCard } from "@/telegram/reminderCard";
import { isWrongCarLocationReminder } from "@/services/v2240ProductionRepair";
import type { AgentAction, PlannerItem, Reminder, ReminderPolicy } from "@/db/schema";

const renagMocks = vi.hoisted(() => ({
  listDue: vi.fn(),
  update: vi.fn(async () => null),
  writeAudit: vi.fn(async () => undefined),
  getUser: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/db/queries/agentActions", () => ({
  listDuePendingAgentActionsByType: renagMocks.listDue,
  recordAgentAction: vi.fn(),
  updateAgentAction: renagMocks.update,
}));
vi.mock("@/db/queries/audit", () => ({
  writeAudit: renagMocks.writeAudit,
}));
vi.mock("@/db/queries/users", () => ({
  getUserById: renagMocks.getUser,
}));
vi.mock("@/telegram/reminderCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/telegram/reminderCard")>();
  return { ...actual, resolveActionableReminderCard: renagMocks.resolve };
});

describe("V2.24 actionable reminder cards", () => {
  it("renders the full standard until-done action set", () => {
    const now = new Date("2026-06-18T10:00:00.000Z");
    const policy = reminderPolicy({ endsAt: new Date("2026-06-18T20:59:00.000Z") });
    const labels = actionableReminderKeyboard({
      reminderId: "11111111-1111-4111-8111-111111111111",
      plannerItemId: policy.itemId,
      policy,
      now,
    })
      .inline_keyboard.flat()
      .map((button) => button.text);

    expect(labels).toEqual([
      "✅ Сделал",
      "😴 30 мин",
      "😴 1 час",
      "😴 2 часа",
      "😴 4 часа",
      "🌙 До завтра",
      "✏️ Изменить",
      "🔕 Остановить",
      "⬅️ К плану",
    ]);
  });

  it("renders technical before-event offsets as human time labels", () => {
    const labels = [
      formatBeforeEventOffset(645, new Date("2026-06-18T05:15:00.000Z"), "Europe/Moscow"),
      formatBeforeEventOffset(165, new Date("2026-06-18T13:15:00.000Z"), "Europe/Moscow"),
      formatBeforeEventOffset(168 * 60, new Date("2026-06-11T16:00:00.000Z"), "Europe/Moscow"),
    ];

    expect(labels).toEqual(["в день визита в 08:15", "в день визита в 16:15", "за неделю"]);
    expect(labels.join(", ")).not.toMatch(/\b\d+\s*(минут|мин|ч)\b/iu);
  });

  it("hides four-hour snooze when it exceeds a finite policy window", () => {
    const actions = actionableReminderActions({
      policy: reminderPolicy({ endsAt: new Date("2026-06-18T11:30:00.000Z") }),
      now: new Date("2026-06-18T10:00:00.000Z"),
    });
    expect(actions).not.toContain("snooze_240");
    expect(actions).toContain("snooze_end_of_day");
  });

  it("renders carryover until-done as today's active continuation", () => {
    const item = plannerItem({
      title: "Решить вопрос с ЭЦП",
      dueAt: new Date("2026-06-17T20:59:00.000Z"),
      metadata: { untilDone: true, untilDoneCarryover: true },
    });
    const policy = reminderPolicy({
      itemId: item.id,
      endsAt: new Date("2026-06-18T20:59:00.000Z"),
      metadata: { untilDone: true, untilDoneCarryover: true, stopCondition: "until_done" },
    });
    const card = renderActionableReminderCard({
      reminder: reminder({ plannerItemId: item.id, policyId: policy.id }),
      item,
      policy,
      now: new Date("2026-06-18T09:00:00.000Z"),
    });

    expect(card.renderMode).toBe("task_until_done");
    expect(card.text).toContain("Не закрыто со вчера. Продолжаю сегодня до 23:59.");
    expect(card.buttonsAttached).toBe(true);
  });

  it("renders a monthly occurrence and never says without time", () => {
    const item = plannerItem({
      kind: "recurring_task",
      title: "Внести показания счетчиков за квартиру",
    });
    const policy = reminderPolicy({
      itemId: item.id,
      policyType: "recurring",
      recurrenceRule: "monthly_days:15,16,17,18,19@12:00",
      startsAt: null,
      endsAt: null,
      intervalMinutes: null,
    });
    const card = renderActionableReminderCard({
      reminder: reminder({
        plannerItemId: item.id,
        policyId: policy.id,
        scheduledAt: new Date("2026-06-18T09:00:00.000Z"),
      }),
      item,
      policy,
      now: new Date("2026-06-18T09:01:00.000Z"),
    });

    expect(card.renderMode).toBe("monthly_occurrence");
    expect(card.text).toContain("Сегодня, 18.06.");
    expect(card.text).toContain("15–19 числа каждого месяца в 12:00");
    expect(card.text).not.toContain("без времени");
  });

  it("renders an open-ended until-done occurrence without a fake deadline", () => {
    const item = plannerItem({
      title: "Починить кран в ванной",
      metadata: { openEndedUntilDone: true, timeScope: "persistent" },
    });
    const policy = reminderPolicy({
      itemId: item.id,
      endsAt: null,
      metadata: {
        openEndedUntilDone: true,
        timeScope: "persistent",
        stopCondition: "until_done",
      },
    });
    const card = renderActionableReminderCard({
      reminder: reminder({ plannerItemId: item.id, policyId: policy.id }),
      item,
      policy,
      now: new Date("2026-06-18T09:00:00.000Z"),
    });

    expect(card.renderMode).toBe("task_until_done");
    expect(card.text).toContain("Повторяю каждый час, пока не отметишь выполненным.");
    expect(card.text).not.toContain("без времени");
    expect(card.text).not.toContain("23:59");
    expect(card.buttonsAttached).toBe(true);
  });

  it("routes the car-location codeword before date parsing", () => {
    const intent = parsePinnedContextIntent({
      text: "Запомни где машина: за ВкусВиллом, завтра у клиники Рошаля.",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-18T09:00:00.000Z"),
    });
    expect(intent).toEqual(
      expect.objectContaining({ type: "create", category: "car_location", title: "Машина" }),
    );
  });

  it("detects a scheduled car-location reminder as a repair candidate", () => {
    expect(
      isWrongCarLocationReminder(
        plannerItem({
          title: "Напоминание об оставленной машине за ВкусВиллом",
          dueAt: new Date("2026-06-19T06:30:00.000Z"),
        }),
      ),
    ).toBe(true);
  });

  it("collapses historical monthly audit duplicates", () => {
    const entries = collapseMonthlyAuditSpam([
      actionLogEntry("new", "2026-06-18T10:01:00.000Z"),
      actionLogEntry("old", "2026-06-18T10:00:00.000Z"),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("new");
    expect(entries[0]?.details.collapsedDuplicates).toBe(1);
  });
});

describe("V2.24 pending prompt re-nag", () => {
  it("sends a freshly rendered actionable keyboard", async () => {
    const { runDuePendingPromptRenags } = await import("@/services/pendingPromptRenag");
    renagMocks.listDue.mockResolvedValueOnce([pendingAction()]);
    renagMocks.getUser.mockResolvedValueOnce({
      id: "22222222-2222-4222-8222-222222222222",
      telegramUserId: 52203584n,
    });
    renagMocks.resolve.mockResolvedValueOnce({
      status: "ready",
      card: {
        text: "Напоминание: тест",
        keyboard: new InlineKeyboard().text("✅ Сделал", "reminder:ack:test"),
        renderMode: "task_until_done",
        allowedActions: ["ack"],
        buttonsAttached: true,
      },
    });
    const sendMessage = vi.fn(async () => ({ message_id: 77 }));

    const result = await runDuePendingPromptRenags({
      now: new Date("2026-06-18T10:06:00.000Z"),
      sender: { sendMessage },
    });

    expect(result.sent).toBe(1);
    expect(sendMessage.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        reply_markup: expect.any(InlineKeyboard),
        disable_notification: false,
      }),
    );
    expect(renagMocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assistant.pending_action_prompt_renag_sent",
        details: expect.objectContaining({
          renderMode: "task_until_done",
          buttonsAttached: true,
        }),
      }),
    );
  });

  it("does not send another re-nag while the policy is snoozed", async () => {
    const { runDuePendingPromptRenags } = await import("@/services/pendingPromptRenag");
    renagMocks.listDue.mockResolvedValueOnce([pendingAction()]);
    renagMocks.getUser.mockResolvedValueOnce({
      id: "22222222-2222-4222-8222-222222222222",
      telegramUserId: 52203584n,
    });
    renagMocks.resolve.mockResolvedValueOnce({
      status: "cancel",
      reason: "policy_snoozed",
    });
    const sendMessage = vi.fn();

    const result = await runDuePendingPromptRenags({
      now: new Date("2026-06-18T10:06:00.000Z"),
      sender: { sendMessage },
    });

    expect(result).toEqual(expect.objectContaining({ checked: 1, sent: 0, cancelled: 1 }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("edits the active re-nag card instead of sending a duplicate", async () => {
    const { runDuePendingPromptRenags } = await import("@/services/pendingPromptRenag");
    renagMocks.listDue.mockResolvedValueOnce([
      pendingAction({ output: { lastTelegramMessageId: 77, renagCount: 1 } }),
    ]);
    renagMocks.getUser.mockResolvedValueOnce({
      id: "22222222-2222-4222-8222-222222222222",
      telegramUserId: 52203584n,
    });
    renagMocks.resolve.mockResolvedValueOnce({
      status: "ready",
      card: {
        text: "Напоминание: тест",
        keyboard: new InlineKeyboard().text("✅ Сделал", "reminder:ack:test"),
        renderMode: "task_until_done",
        allowedActions: ["ack"],
        buttonsAttached: true,
      },
    });
    const sendMessage = vi.fn();
    const editMessageText = vi.fn(async () => true);

    const result = await runDuePendingPromptRenags({
      now: new Date("2026-06-18T10:11:00.000Z"),
      sender: { sendMessage, editMessageText },
    });

    expect(result).toEqual(
      expect.objectContaining({ sent: 0, edited: 1, duplicateActiveSessions: 0 }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessageText).toHaveBeenCalledWith(
      "52203584",
      77,
      "Напоминание: тест",
      expect.objectContaining({ disable_notification: false }),
    );
    expect(renagMocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "assistant.renag_card_edited" }),
    );
  });

  it("sends one loud re-nag and deletes the previous visible card", async () => {
    const { runDuePendingPromptRenags } = await import("@/services/pendingPromptRenag");
    renagMocks.listDue.mockResolvedValueOnce([
      pendingAction({ output: { lastTelegramMessageId: 77, renagCount: 1 } }),
    ]);
    renagMocks.getUser.mockResolvedValueOnce({
      id: "22222222-2222-4222-8222-222222222222",
      telegramUserId: 52203584n,
    });
    renagMocks.resolve.mockResolvedValueOnce({
      status: "ready",
      card: {
        text: "Напоминание: тест",
        keyboard: new InlineKeyboard().text("✅ Сделал", "reminder:ack:test"),
        renderMode: "task_until_done",
        allowedActions: ["ack"],
        buttonsAttached: true,
      },
    });
    const sendMessage = vi.fn(async () => ({ message_id: 78 }));
    const deleteMessage = vi.fn(async () => true);

    const result = await runDuePendingPromptRenags({
      now: new Date("2026-06-18T10:11:00.000Z"),
      sender: { sendMessage, deleteMessage },
    });

    expect(result).toEqual(expect.objectContaining({ sent: 1, replaced: 1 }));
    expect(sendMessage).toHaveBeenCalledWith(
      "52203584",
      "Напоминание: тест",
      expect.objectContaining({ disable_notification: false }),
    );
    expect(deleteMessage).toHaveBeenCalledWith("52203584", 77);
    expect(renagMocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "assistant.renag_previous_card_deleted" }),
    );
  });

  it("treats message_not_modified as an edit no-op success", async () => {
    const { runDuePendingPromptRenags } = await import("@/services/pendingPromptRenag");
    renagMocks.listDue.mockResolvedValueOnce([
      pendingAction({
        output: {
          lastTelegramMessageId: 77,
          renagCount: 1,
          stackDeliveryMode: "edit_only",
        },
      }),
    ]);
    renagMocks.getUser.mockResolvedValueOnce({
      id: "22222222-2222-4222-8222-222222222222",
      telegramUserId: 52203584n,
    });
    renagMocks.resolve.mockResolvedValueOnce({
      status: "ready",
      card: {
        text: "Напоминание: тест",
        keyboard: new InlineKeyboard().text("✅ Сделал", "reminder:ack:test"),
        renderMode: "task_until_done",
        allowedActions: ["ack"],
        buttonsAttached: true,
      },
    });
    const sendMessage = vi.fn();
    const editMessageText = vi.fn(async () => {
      throw new Error("Bad Request: message is not modified");
    });

    const result = await runDuePendingPromptRenags({
      now: new Date("2026-06-18T10:11:00.000Z"),
      sender: { sendMessage, editMessageText },
    });

    expect(result).toEqual(expect.objectContaining({ sent: 0, edited: 1 }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(renagMocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "assistant.renag_edit_noop_success" }),
    );
  });

  it("collapses repeated low-value re-nag audit rows in actionlog", () => {
    const entries = [
      {
        ...actionLogEntry("renag-1", "2026-06-18T10:00:00.000Z"),
        action: "assistant.renag_card_sent_loud",
        details: { targetPolicyId: "policy-1" },
      },
      {
        ...actionLogEntry("renag-2", "2026-06-18T10:05:00.000Z"),
        action: "assistant.renag_card_sent_loud",
        details: { targetPolicyId: "policy-1" },
      },
    ];
    const collapsed = collapseMonthlyAuditSpam(entries);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].details.collapsedDuplicates).toBe(1);
  });
});

function plannerItem(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    userId: "22222222-2222-4222-8222-222222222222",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Тест",
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "task",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: new Date("2026-06-17T10:00:00.000Z"),
    updatedAt: new Date("2026-06-17T10:00:00.000Z"),
    ...overrides,
  };
}

function reminderPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    userId: "22222222-2222-4222-8222-222222222222",
    itemId: "33333333-3333-4333-8333-333333333333",
    title: "Тест",
    category: "task",
    policyType: "nag_until_ack",
    status: "active",
    timezone: "Europe/Moscow",
    startsAt: new Date("2026-06-18T09:00:00.000Z"),
    endsAt: new Date("2026-06-18T20:59:00.000Z"),
    nextFireAt: new Date("2026-06-18T10:00:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: 60,
    requireAck: true,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "move_to_overdue_or_review",
    snoozedUntil: null,
    snoozeScope: null,
    quietHours: null,
    escalationPolicy: null,
    metadata: { untilDone: true, stopCondition: "until_done" },
    createdAt: new Date("2026-06-17T10:00:00.000Z"),
    updatedAt: new Date("2026-06-17T10:00:00.000Z"),
    ...overrides,
  };
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    plannerItemId: "33333333-3333-4333-8333-333333333333",
    type: "until_ack",
    idempotencyKey: "v2240-test-reminder",
    scheduledAt: new Date("2026-06-18T10:00:00.000Z"),
    status: "sent",
    claimedAt: null,
    sentAt: new Date("2026-06-18T10:00:00.000Z"),
    telegramMessageId: null,
    attemptCount: 1,
    lastError: null,
    repeatUntilAck: true,
    ackedAt: null,
    parentReminderId: null,
    recurrenceKey: null,
    policyId: "44444444-4444-4444-8444-444444444444",
    purpose: "reminder",
    menuType: "reminder",
    autoDeleteAfterResponse: true,
    supersededByMessageId: null,
    payload: {},
    createdAt: new Date("2026-06-18T09:59:00.000Z"),
    updatedAt: new Date("2026-06-18T10:00:00.000Z"),
    ...overrides,
  };
}

function pendingAction(overrides: Partial<AgentAction> = {}): AgentAction {
  const base: AgentAction = {
    id: "55555555-5555-4555-8555-555555555555",
    userId: "22222222-2222-4222-8222-222222222222",
    sourceMessageId: null,
    actionType: "pending_prompt_renag_session",
    status: "pending",
    input: {
      promptType: "reminder",
      targetReminderId: "11111111-1111-4111-8111-111111111111",
    },
    output: {
      text: "old text",
      nextRenagAt: "2026-06-18T10:05:00.000Z",
      expiresAt: "2026-06-18T10:30:00.000Z",
      renagCount: 0,
    },
    undoPayload: {},
    createdAt: new Date("2026-06-18T10:00:00.000Z"),
  };
  return {
    ...base,
    ...overrides,
    input: {
      ...base.input,
      ...(overrides.input ?? {}),
    },
    output: {
      ...base.output,
      ...(overrides.output ?? {}),
    },
  };
}

function actionLogEntry(id: string, createdAt: string) {
  return {
    source: "audit" as const,
    id,
    createdAt: new Date(createdAt),
    action: "assistant.monthly_day_range_occurrence_checked",
    entityId: "44444444-4444-4444-8444-444444444444",
    details: {
      auditKey: "44444444-4444-4444-8444-444444444444:2026-06-18",
    },
  };
}
