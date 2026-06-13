import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import {
  normalReminderMenuKeyboard,
  reminderMenuKeyboard,
} from "@/bot/keyboards";
import { parseReminderCadence } from "@/bot/reminderPolicyEditFlow";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { formatRuWeekdayDateRange, formatRuWeekdayDateTime } from "@/domain/dateTime";
import { formatHumanReminderPolicy } from "@/domain/reminderPolicyPresentation";
import {
  planPolicySnooze,
  resolvePolicyReconcileTarget,
} from "@/domain/reminderPolicySchedule";
import { formatDashboardItem } from "@/telegram/liveDashboard";
import {
  isV280CadenceOnlyGarbageTitle,
  isV280RepairSafe,
} from "@/services/v280ProductionRepair";

const timezone = "Europe/Moscow";

describe("V2.8.0 reminder policy UX and snooze", () => {
  it("attaches a cadence-only reply to a future item date instead of the past", () => {
    const parsed = parseReminderCadence({
      text: "Каждый час с 8 утра до 18, пока не отмечу",
      itemAnchor: new Date("2026-06-15T07:20:00.000Z"),
      timezone,
      now: new Date("2026-06-13T13:43:00.000Z"),
    });

    expect(parsed).toEqual(
      expect.objectContaining({
        intervalMinutes: 60,
        startsAt: new Date("2026-06-15T05:00:00.000Z"),
        endsAt: new Date("2026-06-15T15:00:00.000Z"),
        windowStart: "08:00",
        windowEnd: "18:00",
      }),
    );
  });

  it("moves a global past cadence window to the next valid day", () => {
    const parsed = parseReminderCadence({
      text: "Каждый час с 8 утра до 18, пока не отмечу",
      timezone,
      now: new Date("2026-06-13T13:43:00.000Z"),
    });
    expect(parsed?.startsAt).toEqual(new Date("2026-06-14T05:00:00.000Z"));
  });

  it("asks for the task instead of creating a cadence-only garbage task", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text: "Каждый час с 8 утра до 18, пока не отмечу",
      timezone,
      now: new Date("2026-06-13T13:43:00.000Z"),
      activeContext: "none",
    });
    expect(execution.intent).toBe("clarify");
    expect(execution.actionPlan).toBeNull();
    expect(execution.reply).toContain("Что нужно напоминать");
  });

  it("turns the real complex request into a three-intent preview", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text: "Три напоминания: напоминай мне каждый понедельник в течение всего дня раз в час, чтобы я решил вопрос с зеркалом для машины, а ещё с 20-го числа напоминай мне каждый день об оплате квартиры, а 17-18-19 июня напоминай мне каждый час о том, чтобы внести показания счётчика. И вообще, каждый месяц, с 15 по 19 число давай мне такие напоминания",
      timezone,
      now: new Date("2026-06-13T13:43:00.000Z"),
      activeContext: "none",
    });
    expect(execution.actionPlan?.requiresConfirmation).toBe(true);
    expect(execution.actionPlan?.actions).toHaveLength(3);
    expect(execution.actionPlan?.clarificationQuestions.join(" ")).toContain("08:00–18:00");
  });

  it("shows policies inline with a persistent marker and no raw policy type", () => {
    const policy = reminderPolicy();
    const text = formatDashboardItem(plannerItem(), timezone, null, true, [policy], new Date());
    expect(text).toContain("❗ Перенести визит Роба к ортодонту");
    expect(text).toContain("🔔 ❗ каждый час, с 08:00 до 18:00, пока не отмечу");
    expect(text).not.toContain("nag_until_ack");
  });

  it("formats weekdays in user-facing date text", () => {
    expect(formatRuWeekdayDateTime(new Date("2026-06-15T05:00:00.000Z"), timezone)).toBe(
      "Пн, 15.06 08:00",
    );
    expect(
      formatRuWeekdayDateRange(
        new Date("2026-06-15T05:00:00.000Z"),
        new Date("2026-06-15T15:00:00.000Z"),
        timezone,
      ),
    ).toBe("Пн, 15.06 08:00–18:00");
  });

  it("does not let the reconciler materialize a snoozed policy", () => {
    const policy = reminderPolicy({
      snoozedUntil: new Date("2026-06-15T09:15:00.000Z"),
    });
    expect(resolvePolicyReconcileTarget(policy, new Date("2026-06-15T08:00:00.000Z"))).toBeNull();
  });

  it("resumes an hourly policy once on the next grid slot after snooze", () => {
    const plan = planPolicySnooze({
      anchor: new Date("2026-06-15T05:00:00.000Z"),
      intervalMinutes: 60,
      now: new Date("2026-06-15T07:15:00.000Z"),
      snoozeMinutes: 120,
      endsAt: new Date("2026-06-15T15:00:00.000Z"),
    });

    expect(plan.snoozeAt).toEqual(new Date("2026-06-15T09:15:00.000Z"));
    expect(plan.nextRegularAt).toEqual(new Date("2026-06-15T10:00:00.000Z"));
  });

  it("offers the required high-frequency snooze buttons", () => {
    const labels = reminderMenuKeyboard("reminder", "item").inline_keyboard
      .flat()
      .map((button) => button.text);
    expect(labels).toEqual(
      expect.arrayContaining(["😴 30 мин", "😴 1 час", "😴 2 часа", "😴 до завтра"]),
    );
  });

  it("offers done, one-hour snooze and edit on normal reminders", () => {
    const labels = normalReminderMenuKeyboard("reminder", "item").inline_keyboard
      .flat()
      .map((button) => button.text);
    expect(labels).toEqual(
      expect.arrayContaining(["✅ Сделал", "😴 1 час", "✏️ Изменить"]),
    );
  });

  it("renders a human policy summary", () => {
    expect(formatHumanReminderPolicy(reminderPolicy(), timezone)).toBe(
      "❗ каждый час, с 08:00 до 18:00, пока не отмечу",
    );
  });

  it("keeps the production repair conservative and idempotent", () => {
    expect(isV280CadenceOnlyGarbageTitle("Каждый час с 8 утра до 18")).toBe(true);
    expect(isV280CadenceOnlyGarbageTitle("Каждый час решать вопрос с зеркалом")).toBe(false);
    expect(isV280RepairSafe(1, 1)).toBe(true);
    expect(isV280RepairSafe(0, 1)).toBe(false);
    expect(isV280RepairSafe(1, 2)).toBe(false);
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

function reminderPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: "policy",
    userId: "user",
    itemId: "item",
    title: "Перенести визит Роба к ортодонту",
    category: "health",
    policyType: "nag_until_ack",
    status: "active",
    timezone,
    startsAt: new Date("2026-06-15T05:00:00.000Z"),
    endsAt: new Date("2026-06-15T15:00:00.000Z"),
    nextFireAt: new Date("2026-06-15T05:00:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: 60,
    requireAck: true,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "keep_open",
    snoozedUntil: null,
    snoozeScope: null,
    quietHours: null,
    escalationPolicy: null,
    metadata: { stopOnItemComplete: true },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function plannerItem(): PlannerItem {
  return {
    id: "item",
    userId: "user",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Перенести визит Роба к ортодонту",
    description: null,
    location: null,
    timezone,
    startAt: null,
    endAt: null,
    dueAt: new Date("2026-06-15T05:00:00.000Z"),
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "health",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
