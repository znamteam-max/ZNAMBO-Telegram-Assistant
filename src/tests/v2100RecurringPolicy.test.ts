import { beforeEach, describe, expect, it, vi } from "vitest";

const repairMocks = vi.hoisted(() => ({
  listManageableItems: vi.fn(),
  cancelPlannerItemWithMetadata: vi.fn(),
  listActiveReminderPolicies: vi.fn(),
  updateReminderPolicy: vi.fn(),
  cancelPendingRemindersForPolicy: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/db/queries/items", () => ({
  listManageableItems: repairMocks.listManageableItems,
  cancelPlannerItemWithMetadata: repairMocks.cancelPlannerItemWithMetadata,
}));
vi.mock("@/db/queries/reminderPolicies", () => ({
  listActiveReminderPolicies: repairMocks.listActiveReminderPolicies,
  updateReminderPolicy: repairMocks.updateReminderPolicy,
}));
vi.mock("@/db/queries/reminders", () => ({
  cancelPendingRemindersForPolicy: repairMocks.cancelPendingRemindersForPolicy,
}));
vi.mock("@/db/queries/audit", () => ({
  writeAudit: repairMocks.writeAudit,
}));

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import { recurringTimeClarificationKeyboard } from "@/bot/keyboards";
import {
  materializeReminderPolicyDraft,
  parseReminderPolicyDraftInput,
} from "@/bot/reminderPolicyEditFlow";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { parseDeadlineSemantics } from "@/domain/deadlineSemantics";
import { formatHumanReminderPolicy } from "@/domain/reminderPolicyPresentation";
import { computeNextPolicySlotAfterDelivery } from "@/domain/reminderPolicySchedule";
import {
  formatRecurringRuleHuman,
  isCadenceOnlyTitle,
  nextRecurringOccurrence,
  parseRecurringPolicyIntents,
  parseStopCondition,
} from "@/domain/recurringPolicySemantics";
import {
  applyV2100ProductionRepair,
  isV2100CadenceTitleGarbage,
  previewV2100ProductionRepair,
} from "@/services/v2100ProductionRepair";

const timezone = "Europe/Moscow";
const now = new Date("2026-06-14T11:43:00.000Z");

describe("V2.10.0 recurring policy execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repairMocks.listManageableItems.mockResolvedValue([]);
    repairMocks.listActiveReminderPolicies.mockResolvedValue([]);
    repairMocks.writeAudit.mockResolvedValue(undefined);
  });

  it("parses a weekly until-done reminder without turning cadence into the title", () => {
    const [intent] = parseRecurringPolicyIntents(
      "Каждый понедельник напоминай мне проверить и решить вопрос с зеркалом на машину, пока не выполню или не перенесу.",
    );
    expect(intent).toEqual(
      expect.objectContaining({
        title: "Проверить и решить вопрос с зеркалом на машину",
        recurrenceRule: "weekly:MO",
        requireAck: true,
        ackAliases: ["done", "rescheduled"],
        missingFields: ["reminderTime"],
      }),
    );
    expect(isCadenceOnlyTitle(intent.title)).toBe(false);
    expect(isCadenceOnlyTitle("Каждый понедельник")).toBe(true);
  });

  it("creates a complete weekly policy proposal when time is present", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text: "Каждый понедельник в 10:00 напоминай решить вопрос с зеркалом для машины, пока не выполню.",
      timezone,
      now,
      activeContext: "none",
    });
    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({
        kind: "recurring_task",
        title: "Решить вопрос с зеркалом для машины",
      }),
    );
    expect(execution.reminderPolicies[0]).toEqual(
      expect.objectContaining({
        operation: "create_recurring_policy",
        recurrenceRule: "weekly:MO@10:00",
        requireAck: true,
        nextFireAtLocal: "2026-06-15T10:00:00",
      }),
    );
  });

  it.each([
    [
      "Каждый месяц 15, 16, 17, 18 и 19 числа напоминай внести показания счётчика за квартиру.",
      "monthly_days:15,16,17,18,19",
    ],
    [
      "Каждый месяц с 15 по 19 число напоминай внести показания счётчика за квартиру.",
      "monthly_days:15,16,17,18,19",
    ],
  ])("parses monthly day ranges: %s", (text, recurrenceRule) => {
    const [intent] = parseRecurringPolicyIntents(text);
    expect(intent).toEqual(
      expect.objectContaining({
        title: "Внести показания счётчика за квартиру",
        recurrenceRule,
        monthDays: [15, 16, 17, 18, 19],
        missingFields: ["reminderTime"],
      }),
    );
    expect(formatRecurringRuleHuman(recurrenceRule)).toBe(
      "15–19 числа каждого месяца",
    );
  });

  it("keeps two recurring intents in one preview instead of creating garbage", () => {
    const text =
      "Нужно два напоминания. Каждый понедельник напоминай мне о том, что нужно решить вопрос с зеркалом для машины, пока я не выполню. А также каждый месяц с 15 по 19 число напоминай мне вносить показания счётчика за квартиру до тех пор, пока я не выполню.";
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text,
      timezone,
      now,
      activeContext: "none",
    });
    expect(execution.actionPlan?.actions).toHaveLength(2);
    expect(execution.actionPlan?.requiresConfirmation).toBe(true);
    expect(execution.actionPlan?.actions.map((action) => action.title)).toEqual([
      "Решить вопрос с зеркалом для машины",
      "Вносить показания счётчика за квартиру",
    ]);
    expect(execution.reminderPolicies.map((policy) => policy.recurrenceRule)).toEqual([
      "weekly:MO",
      "monthly_days:15,16,17,18,19",
    ]);
  });

  it("calculates weekly and monthly slots in the user timezone", () => {
    expect(
      nextRecurringOccurrence({
        rule: "weekly:MO@10:00",
        after: now,
        timezone,
      }),
    ).toEqual(new Date("2026-06-15T07:00:00.000Z"));
    expect(
      nextRecurringOccurrence({
        rule: "monthly_days:15,16,17,18,19@12:00",
        after: now,
        timezone,
      }),
    ).toEqual(new Date("2026-06-15T09:00:00.000Z"));
  });

  it("continues a monthly range policy on the next configured day", () => {
    expect(
      computeNextPolicySlotAfterDelivery({
        policy: reminderPolicy(),
        scheduledFor: new Date("2026-06-15T09:00:00.000Z"),
        now: new Date("2026-06-15T09:01:00.000Z"),
      }),
    ).toEqual(new Date("2026-06-16T09:00:00.000Z"));
    expect(formatHumanReminderPolicy(reminderPolicy(), timezone)).toContain(
      "15–19 числа каждого месяца в 12:00",
    );
  });

  it("keeps recurring clarification callback payloads within Telegram limit", () => {
    const keyboard = recurringTimeClarificationKeyboard(
      "12345678-1234-4234-9234-123456789012",
      true,
    );
    for (const button of keyboard.inline_keyboard.flat()) {
      if ("callback_data" in button && button.callback_data) {
        expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });

  it.each([
    ["Пока не выполню", ["done"]],
    ["пока не оплачу", ["done"]],
    ["до тех пор пока я не сделаю", ["done"]],
    ["пока не отмечу выполненным", ["done"]],
    ["пока не выполню или не перенесу", ["done", "rescheduled"]],
  ])("recognizes stop condition: %s", (text, aliases) => {
    expect(parseStopCondition(text)?.ackAliases).toEqual(aliases);
  });

  it("stores stop-only setup input and asks only for the missing cadence", () => {
    expect(parseReminderPolicyDraftInput("Пока не выполню")).toEqual({
      intervalMinutes: undefined,
      windowStart: undefined,
      windowEnd: undefined,
    });
    const interval = parseReminderPolicyDraftInput("Каждый час");
    expect(interval.intervalMinutes).toBe(60);
    const end = parseReminderPolicyDraftInput("до 21:00");
    expect(end.windowEnd).toBe("21:00");
    const materialized = materializeReminderPolicyDraft({
      draft: {
        intervalMinutes: 60,
        windowEnd: "21:00",
        stopCondition: "until_done",
      },
      timezone,
      now,
    });
    expect(materialized).toEqual(
      expect.objectContaining({
        intervalMinutes: 60,
        endsAt: new Date("2026-06-14T18:00:00.000Z"),
      }),
    );
  });

  it("uses local 23:59 for today and tomorrow end-of-day deadlines", () => {
    const today = parseDeadlineSemantics({
      text: "Сегодня до конца дня нужно сделать план на длинный обзор событий чемпионата мира.",
      timezone,
      now,
    });
    const tomorrow = parseDeadlineSemantics({
      text: "Завтра до конца дня нужно сделать план на длинный обзор событий чемпионата мира.",
      timezone,
      now,
    });
    expect(today?.dueLocal.toFormat("yyyy-MM-dd HH:mm ZZZZ")).toBe(
      "2026-06-14 23:59 GMT+3",
    );
    expect(today?.title).toBe("Сделать план на длинный обзор событий чемпионата мира");
    expect(tomorrow?.dueLocal.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-06-15 23:59");
  });

  it("keeps the V2.9 explicit deadline behavior", () => {
    const parsed = parseDeadlineSemantics({
      text: 'Сделать цитаты "норм / стрём" для эфира Больше, дедлайн завтра до 14.00',
      timezone,
      now,
    });
    expect(parsed?.dueLocal.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-06-15 14:00");
    expect(parsed?.scheduledStartLocal).toBeNull();
    expect(parsed?.scheduledEndLocal).toBeNull();
  });

  it("repairs only the known cadence-title task and never touches Yandex", async () => {
    const item = plannerItem();
    const policy = reminderPolicy({
      id: "garbage-policy",
      itemId: item.id,
      title: "Каждый понедельник",
      recurrenceRule: null,
      intervalMinutes: 60,
    });
    repairMocks.listManageableItems.mockResolvedValueOnce([item]).mockResolvedValueOnce([item]);
    repairMocks.listActiveReminderPolicies
      .mockResolvedValueOnce([policy])
      .mockResolvedValueOnce([policy]);
    repairMocks.cancelPlannerItemWithMetadata.mockResolvedValue({
      ...item,
      status: "cancelled",
    });
    repairMocks.updateReminderPolicy.mockResolvedValue({
      ...policy,
      status: "cancelled",
    });

    expect(isV2100CadenceTitleGarbage("Каждый понедельник")).toBe(true);
    expect(isV2100CadenceTitleGarbage("Проверить зеркало каждый понедельник")).toBe(false);
    const preview = await previewV2100ProductionRepair({ userId: "user" });
    expect(preview).toEqual(
      expect.objectContaining({
        safeToApply: true,
        calendarObjectsToDelete: 0,
      }),
    );
    const applied = await applyV2100ProductionRepair({ userId: "user" });
    expect(applied.archivedItemIds).toEqual(["garbage-item"]);
    expect(applied.archivedPolicyIds).toEqual(["garbage-policy"]);
    expect(applied.calendarObjectsChanged).toBe(0);

    repairMocks.listManageableItems.mockResolvedValue([]);
    repairMocks.listActiveReminderPolicies.mockResolvedValue([]);
    expect((await previewV2100ProductionRepair({ userId: "user" })).safeToApply).toBe(false);
  });
});

function emptyExecution() {
  return agentExecutionSchema.parse({
    intent: "clarify",
    reply: "Уточни.",
    actionPlan: null,
    viewScope: null,
    resetMode: null,
    itemUpdates: [],
    reminderPolicies: [],
    memoryFacts: [],
    clarificationQuestions: ["Уточни."],
  });
}

function plannerItem(): PlannerItem {
  return {
    id: "garbage-item",
    userId: "user",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Каждый понедельник",
    description: null,
    location: null,
    timezone,
    startAt: null,
    endAt: null,
    dueAt: new Date("2026-06-14T20:59:00.000Z"),
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "today_focus",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function reminderPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: "monthly-policy",
    userId: "user",
    itemId: "monthly-item",
    title: "Внести показания счётчика за квартиру",
    category: "recurring_finance",
    policyType: "recurring",
    status: "active",
    timezone,
    startsAt: null,
    endsAt: null,
    nextFireAt: new Date("2026-06-15T09:00:00.000Z"),
    recurrenceRule: "monthly_days:15,16,17,18,19@12:00",
    intervalMinutes: null,
    requireAck: true,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    snoozedUntil: null,
    snoozeScope: null,
    quietHours: null,
    escalationPolicy: null,
    metadata: { stopCondition: "until_done", stopOnItemComplete: true },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
