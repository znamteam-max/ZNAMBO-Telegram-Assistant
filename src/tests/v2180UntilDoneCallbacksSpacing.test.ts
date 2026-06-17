import { describe, expect, it, vi } from "vitest";

import { callbackReliabilityMiddleware, STALE_CALLBACK_MESSAGE } from "@/bot/callbackReliability";
import { formatReminderMessage } from "@/bot/formatters";
import { eventReminderMenuKeyboard } from "@/bot/keyboards";
import { formatMultiReminderApplied } from "@/bot/multiReminderSetupFlow";
import { chooseSpacedReminderSlot } from "@/services/reminderCollisionSpacing";
import { planSmartExtraEventReminder } from "@/domain/eventReminderSemantics";
import {
  formatUntilDoneReminderSummary,
  normalizeUntilDoneReminder,
} from "@/domain/untilDoneReminderText";
import { collectV2180ProductionRepairCandidates } from "@/services/v2180ProductionRepair";
import type { AgentAction, PlannerItem, Reminder, ReminderPolicy } from "@/db/schema";

const auditMocks = vi.hoisted(() => ({
  writeAudit: vi.fn(async () => undefined),
}));

vi.mock("@/db/queries/audit", () => ({
  writeAudit: auditMocks.writeAudit,
}));

vi.mock("@/telegram/entityCards", () => ({
  renderEntityCard: vi.fn(),
}));

describe("V2.18.0 until-done, callback and spacing fixes", () => {
  it("normalizes today whole day into hourly until-done until 23:59", () => {
    const normalized = normalizeUntilDoneReminder({
      text: "Сегодня целый день",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-17T07:05:10.000Z"),
    });

    expect(normalized).toEqual(
      expect.objectContaining({
        intervalMinutes: 60,
        requireAck: true,
        stopCondition: "until_done",
        catchUpMode: "one_immediate_then_resume",
        windowEnd: "23:59",
      }),
    );
    expect(normalized?.startsAt.toISOString()).toBe("2026-06-17T07:06:00.000Z");
    expect(normalized?.endsAt.toISOString()).toBe("2026-06-17T20:59:00.000Z");
    expect(
      formatUntilDoneReminderSummary({
        normalized: normalized!,
        timezone: "Europe/Moscow",
      }),
    ).toContain("каждый час до конца дня");
  });

  it("uses explicit cadence override for until-done text", () => {
    const normalized = normalizeUntilDoneReminder({
      text: "Каждые 30 минут пока не сделаю",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-17T07:05:10.000Z"),
    });

    expect(normalized?.intervalMinutes).toBe(30);
    expect(normalized?.cadenceExplicit).toBe(true);
  });

  it("spaces colliding reminders by five minutes", () => {
    const first = chooseSpacedReminderSlot({
      desiredAt: new Date("2026-06-17T10:00:00.000Z"),
      occupiedSlots: [],
    });
    const second = chooseSpacedReminderSlot({
      desiredAt: new Date("2026-06-17T10:00:00.000Z"),
      occupiedSlots: [first.scheduledAt],
    });
    const third = chooseSpacedReminderSlot({
      desiredAt: new Date("2026-06-17T10:00:00.000Z"),
      occupiedSlots: [first.scheduledAt, second.scheduledAt],
    });

    expect(first.scheduledAt.toISOString()).toBe("2026-06-17T10:00:00.000Z");
    expect(second.scheduledAt.toISOString()).toBe("2026-06-17T10:05:00.000Z");
    expect(third.scheduledAt.toISOString()).toBe("2026-06-17T10:10:00.000Z");
    expect(second.shiftMinutes).toBe(5);
    expect(third.shiftMinutes).toBe(10);
  });

  it("does not push a before-event reminder beyond latest safe slot", () => {
    const result = chooseSpacedReminderSlot({
      desiredAt: new Date("2026-06-17T10:00:00.000Z"),
      occupiedSlots: [new Date("2026-06-17T10:00:00.000Z")],
      latestAt: new Date("2026-06-17T10:02:00.000Z"),
    });

    expect(result.scheduledAt.toISOString()).toBe("2026-06-17T10:00:00.000Z");
    expect(result.shifted).toBe(false);
    expect(result.blockedReason).toBe("latest_at_exceeded");
  });

  it("renders event reminder buttons without task completion actions", () => {
    const item = plannerItem({
      startAt: new Date("2026-06-17T10:00:00.000Z"),
      endAt: new Date("2026-06-17T11:00:00.000Z"),
    });
    const labels = eventReminderMenuKeyboard(
      "11111111-1111-4111-8111-111111111112",
      item,
      new Date("2026-06-17T09:20:00.000Z"),
    )
      .inline_keyboard.flat()
      .map((button) => button.text);

    expect(labels).toContain("✅ Помню");
    expect(labels).toContain("🔔 Напомни ещё");
    expect(labels).toContain("🕒 Через 30 мин");
    expect(labels).not.toContain("✅ Сделал");
    expect(labels).not.toContain("🕒 Через 1 час");
  });

  it("formats event reminders as event-aware cards", () => {
    const item = plannerItem({ title: "Эфир ВС" });
    const reminder = { type: "event_before", repeatUntilAck: false } as Reminder;

    const text = formatReminderMessage(reminder, item);

    expect(text).toContain("🔔 Напоминание о событии");
    expect(text).toContain("Эфир ВС");
    expect(text).not.toContain("Напоминание: Эфир ВС");
  });

  it("plans smart extra event reminders before event start", () => {
    const item = plannerItem({ startAt: new Date("2026-06-17T12:00:00.000Z") });

    expect(
      planSmartExtraEventReminder({
        item,
        now: new Date("2026-06-17T10:00:00.000Z"),
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "scheduled",
        minutesFromNow: 60,
      }),
    );
    expect(
      planSmartExtraEventReminder({
        item,
        now: new Date("2026-06-17T11:15:00.000Z"),
      }),
    ).toEqual(expect.objectContaining({ kind: "scheduled", minutesFromNow: 20 }));
    expect(
      planSmartExtraEventReminder({
        item,
        now: new Date("2026-06-17T11:52:00.000Z"),
      }),
    ).toEqual(expect.objectContaining({ kind: "needs_choice" }));
  });

  it("callback middleware audits and visibly handles unknown callbacks", async () => {
    auditMocks.writeAudit.mockClear();
    const answerCallbackQuery = vi.fn(async () => undefined);
    const reply = vi.fn(async () => ({ message_id: 10 }));
    const ctx = {
      owner: { id: "user-id", timezone: "Europe/Moscow" },
      update: { update_id: 777 },
      callbackQuery: {
        id: "callback-id",
        data: "stale:button",
        message: { chat: { id: 42 }, message_id: 5 },
      },
      answerCallbackQuery,
      reply,
    };

    await callbackReliabilityMiddleware()(ctx as never, async () => undefined);

    expect(answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(STALE_CALLBACK_MESSAGE);
    expect(auditMocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "assistant.callback_received" }),
    );
    expect(auditMocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "assistant.callback_expired" }),
    );
    expect(auditMocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "assistant.callback_completed" }),
    );
  });

  it("callback middleware audits errors and still answers callback query", async () => {
    auditMocks.writeAudit.mockClear();
    const answerCallbackQuery = vi.fn(async () => undefined);
    const reply = vi.fn(async () => ({ message_id: 11 }));
    const ctx = {
      owner: { id: "user-id", timezone: "Europe/Moscow" },
      update: { update_id: 778 },
      callbackQuery: {
        id: "callback-id",
        data: "boom:button",
        message: { chat: { id: 42 }, message_id: 6 },
      },
      answerCallbackQuery,
      reply,
    };

    await callbackReliabilityMiddleware()(ctx as never, async () => {
      throw new Error("handler_failed");
    });

    expect(answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(
      "Не смог обработать кнопку. Обновил карточку — выбери действие заново.",
    );
    expect(auditMocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "assistant.callback_error" }),
    );
  });

  it("formats deterministic multi-reminder setup as one compact summary", () => {
    const text = formatMultiReminderApplied(
      plannerItem({ title: "Созвон с Winline" }),
      [
        { label: "за 2 часа", fireAtLocal: "2026-06-17T13:30:00" },
        { label: "за час", fireAtLocal: "2026-06-17T14:30:00" },
        { label: "за 30 минут", fireAtLocal: "2026-06-17T15:00:00" },
      ],
      [],
    );

    expect(text).toBe(
      [
        "Готово:",
        "• Созвон с Winline",
        "Напоминания добавлены: за 2 часа, за час, за 30 минут.",
      ].join("\n"),
    );
  });

  it("repair includes review-required and one-time before-event policies", () => {
    const event = plannerItem({
      id: "11111111-1111-4111-8111-111111111111",
      title: "Созвон с Winline",
      startAt: new Date("2026-06-17T12:30:00.000Z"),
    });
    const candidates = collectV2180ProductionRepairCandidates({
      items: [event],
      policies: [
        reminderPolicy({
          id: "review-required",
          itemId: event.id,
          policyType: "before_event",
          startsAt: null,
          nextFireAt: null,
          metadata: { reviewRequired: true },
        }),
        reminderPolicy({
          id: "one-time-before",
          itemId: event.id,
          policyType: "one_time",
          startsAt: new Date("2026-06-17T10:30:00.000Z"),
          nextFireAt: new Date("2026-06-17T10:30:00.000Z"),
          metadata: { minutesBefore: 120 },
        }),
      ],
      sessions: [agentAction({ actionType: "pending_prompt_renag_session" })],
      now: new Date("2026-06-16T12:00:00.000Z"),
    });

    expect(candidates.genericBeforeEventPolicyIds).toEqual(["review-required", "one-time-before"]);
  });
});

function plannerItem(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    pendingActionId: null,
    kind: "event",
    status: "active",
    title: "Созвон",
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: new Date("2026-06-17T12:30:00.000Z"),
    endAt: new Date("2026-06-17T13:30:00.000Z"),
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "event",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: new Date("2026-06-16T10:00:00.000Z"),
    updatedAt: new Date("2026-06-16T10:00:00.000Z"),
    ...overrides,
  };
}

function reminderPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: crypto.randomUUID(),
    userId: "22222222-2222-4222-8222-222222222222",
    itemId: "11111111-1111-4111-8111-111111111111",
    title: "Созвон",
    category: "pre_event",
    policyType: "before_event",
    status: "active",
    timezone: "Europe/Moscow",
    startsAt: new Date("2026-06-17T10:30:00.000Z"),
    endsAt: null,
    nextFireAt: new Date("2026-06-17T10:30:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: null,
    requireAck: false,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    snoozedUntil: null,
    snoozeScope: null,
    quietHours: null,
    escalationPolicy: null,
    metadata: {},
    createdAt: new Date("2026-06-16T10:00:00.000Z"),
    updatedAt: new Date("2026-06-16T10:00:00.000Z"),
    ...overrides,
  };
}

function agentAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: crypto.randomUUID(),
    userId: "22222222-2222-4222-8222-222222222222",
    sourceMessageId: null,
    actionType: "pending_prompt_renag_session",
    status: "pending",
    input: {},
    output: {},
    undoPayload: {},
    createdAt: new Date("2026-06-16T10:00:00.000Z"),
    ...overrides,
  };
}
