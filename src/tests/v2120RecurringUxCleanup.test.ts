import { beforeEach, describe, expect, it, vi } from "vitest";

const repairMocks = vi.hoisted(() => ({
  listManageableItems: vi.fn(),
  updatePlannerItemDetails: vi.fn(),
  listActiveReminderPolicies: vi.fn(),
  createReminderPolicyIfMissing: vi.fn(),
  updateReminderPolicy: vi.fn(),
  cancelPendingRemindersForPolicy: vi.fn(),
  listPendingAgentActionsByTypes: vi.fn(),
  updateAgentAction: vi.fn(),
  writeAudit: vi.fn(),
  materializeNextPolicyReminder: vi.fn(),
}));

vi.mock("@/db/queries/items", () => ({
  listManageableItems: repairMocks.listManageableItems,
  updatePlannerItemDetails: repairMocks.updatePlannerItemDetails,
}));
vi.mock("@/db/queries/reminderPolicies", () => ({
  listActiveReminderPolicies: repairMocks.listActiveReminderPolicies,
  createReminderPolicyIfMissing: repairMocks.createReminderPolicyIfMissing,
  updateReminderPolicy: repairMocks.updateReminderPolicy,
  listReminderPoliciesForItem: vi.fn(),
}));
vi.mock("@/db/queries/reminders", () => ({
  cancelPendingRemindersForPolicy: repairMocks.cancelPendingRemindersForPolicy,
}));
vi.mock("@/db/queries/agentActions", () => ({
  listPendingAgentActionsByTypes: repairMocks.listPendingAgentActionsByTypes,
  updateAgentAction: repairMocks.updateAgentAction,
}));
vi.mock("@/db/queries/audit", () => ({
  writeAudit: repairMocks.writeAudit,
}));
vi.mock("@/services/reminderPolicyEngine", () => ({
  materializeNextPolicyReminder: repairMocks.materializeNextPolicyReminder,
}));

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import {
  parseReminderCadence,
  parseReminderPolicyDraftInput,
} from "@/bot/reminderPolicyEditFlow";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";
import { formatHumanReminderPolicy } from "@/domain/reminderPolicyPresentation";
import {
  computeNextPolicySlotAfterDelivery,
  resolvePolicyReconcileTarget,
} from "@/domain/reminderPolicySchedule";
import {
  normalizeRecurringReminderTitle,
  parseRecurringPolicyIntents,
} from "@/domain/recurringPolicySemantics";
import { formatDashboardItem } from "@/telegram/liveDashboard";
import {
  applyV2120ProductionRepair,
  previewV2120ProductionRepair,
} from "@/services/v2120ProductionRepair";

const timezone = "Europe/Moscow";
const now = new Date("2026-06-14T11:43:00.000Z");

describe("V2.12.0 recurring UX cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repairMocks.listManageableItems.mockResolvedValue([]);
    repairMocks.listActiveReminderPolicies.mockResolvedValue([]);
    repairMocks.listPendingAgentActionsByTypes.mockResolvedValue([]);
    repairMocks.updateReminderPolicy.mockImplementation((params) =>
      Promise.resolve({ id: params.policyId, ...params }),
    );
    repairMocks.updatePlannerItemDetails.mockImplementation((params) =>
      Promise.resolve({ id: params.itemId, ...params }),
    );
    repairMocks.updateAgentAction.mockImplementation((params) =>
      Promise.resolve({ id: params.actionId, ...params }),
    );
    repairMocks.writeAudit.mockResolvedValue(undefined);
    repairMocks.materializeNextPolicyReminder.mockResolvedValue(null);
  });

  it.each([
    ["Каждый час с 8 утра до 8 вечера, пока не отмечу", "08:00", "20:00"],
    ["Каждый час с восьми утра до восьми вечера", "08:00", "20:00"],
    ["Каждый час с 10 утра до 6 вечера", "10:00", "18:00"],
    ["Каждый час с 8.00 до 20.00", "08:00", "20:00"],
    ["Каждый час с 8:00 до 20:00", "08:00", "20:00"],
  ])("parses natural reminder windows: %s", (text, start, end) => {
    expect(parseReminderPolicyDraftInput(text)).toEqual(
      expect.objectContaining({
        intervalMinutes: 60,
        windowStart: start,
        windowEnd: end,
      }),
    );
  });

  it("still supports local end-of-day during setup", () => {
    expect(parseReminderPolicyDraftInput("до конца сегодняшнего дня")).toEqual(
      expect.objectContaining({ windowEnd: "23:59", windowEndDayOffset: 0 }),
    );
  });

  it("anchors cadence windows to the item day without inventing the current minute", () => {
    const parsed = parseReminderCadence({
      text: "Каждый час с 8 утра до 8 вечера, пока не отмечу",
      itemAnchor: new Date("2026-06-15T07:20:00.000Z"),
      timezone,
      now,
    });
    expect(parsed).toEqual(
      expect.objectContaining({
        intervalMinutes: 60,
        startsAt: new Date("2026-06-15T05:00:00.000Z"),
        endsAt: new Date("2026-06-15T17:00:00.000Z"),
        windowStart: "08:00",
        windowEnd: "20:00",
      }),
    );
  });

  it("parses monthly 15-19 ranges as typed drafts when time is missing", () => {
    const [intent] = parseRecurringPolicyIntents(
      "Каждый месяц с 15 числа по 19 число напоминай мне внести показания счетчиков за квартиру",
    );
    expect(intent).toEqual(
      expect.objectContaining({
        title: "Внести показания счетчиков за квартиру",
        recurrenceRule: "monthly_days:15,16,17,18,19",
        missingFields: ["reminderTime"],
      }),
    );

    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text: "С 15 по 19 число каждого месяца напоминай внести показания счетчиков за квартиру",
      timezone,
      now,
      activeContext: "none",
    });
    expect(execution.actionPlan?.requiresConfirmation).toBe(true);
    expect(execution.reminderPolicies[0]).toEqual(
      expect.objectContaining({
        recurrenceRule: "monthly_days:15,16,17,18,19",
        nextFireAtLocal: null,
      }),
    );
  });

  it("keeps a monthly 15-19 range complete when time is explicit", () => {
    const [intent] = parseRecurringPolicyIntents(
      "Каждый месяц с 15 числа по 19 число в 12:00 напоминай внести показания счетчиков за квартиру",
    );
    expect(intent.recurrenceRule).toBe("monthly_days:15,16,17,18,19@12:00");
  });

  it("normalizes recurring filler titles", () => {
    expect(
      normalizeRecurringReminderTitle("О том, чтобы я решил вопрос с зеркалом для машины"),
    ).toBe("Решить вопрос с зеркалом для машины");
    expect(
      normalizeRecurringReminderTitle("о том, что нужно внести показания счетчика"),
    ).toBe("Внести показания счетчика");
    const [intent] = parseRecurringPolicyIntents(
      "Каждый понедельник напоминай мне о том, чтобы я решил вопрос с зеркалом для машины",
    );
    expect(intent.title).toBe("Решить вопрос с зеркалом для машины");
  });

  it("renders Plan rows without duplicate persistent marker and without 'без времени'", () => {
    const text = formatDashboardItem(
      mirrorItem({ title: "Решить вопрос с зеркалом для машины" }),
      timezone,
      null,
      true,
      [mirrorPolicy()],
      now,
    );
    expect(text).toContain("❗ Решить вопрос с зеркалом для машины");
    expect(text).toContain("Правило: по понедельникам, каждый час, с 08:00 до 20:00");
    expect(text).not.toContain("без времени");
    expect(text).not.toContain("🔔");
  });

  it("lets item metadata hide or force the persistent marker", () => {
    const hidden = formatDashboardItem(
      mirrorItem({ metadata: { persistentMarkerMode: "hide" } }),
      timezone,
      null,
      true,
      [mirrorPolicy()],
      now,
    );
    const forced = formatDashboardItem(
      mirrorItem({ metadata: { persistentMarkerMode: "show" } }),
      timezone,
      null,
      true,
      [],
      now,
    );
    expect(hidden.split("\n")[0]).not.toContain("❗");
    expect(forced.split("\n")[0]).toContain("❗");
  });

  it("formats legacy 300-minute policies as five-hour reminders", () => {
    expect(
      formatHumanReminderPolicy(
        fedotovPolicy({ metadata: { activeWindowStart: "20:00", activeWindowEnd: "02:59" } }),
        timezone,
        { includeMarker: false },
      ),
    ).toContain("каждые 5 часов");
  });

  it("executes recurring interval windows inside the weekly window and advances to next week", () => {
    const policy = mirrorPolicy({ nextFireAt: new Date("2026-06-15T05:00:00.000Z") });
    const target = resolvePolicyReconcileTarget(policy, new Date("2026-06-15T06:12:00.000Z"));
    expect(target).toEqual({
      scheduledFor: new Date("2026-06-15T06:00:00.000Z"),
      deliveryAt: new Date("2026-06-15T06:12:00.000Z"),
      catchUp: true,
    });
    expect(
      computeNextPolicySlotAfterDelivery({
        policy,
        scheduledFor: new Date("2026-06-15T06:00:00.000Z"),
        now: new Date("2026-06-15T06:12:00.000Z"),
      }),
    ).toEqual(new Date("2026-06-15T07:00:00.000Z"));
    expect(
      computeNextPolicySlotAfterDelivery({
        policy,
        scheduledFor: new Date("2026-06-15T17:00:00.000Z"),
        now: new Date("2026-06-15T17:01:00.000Z"),
      }),
    ).toEqual(new Date("2026-06-22T05:00:00.000Z"));
  });

  it("previews and applies V2.12 production repair without touching calendar objects", async () => {
    const item = mirrorItem({
      title: "О том, чтобы я решил вопрос с зеркалом для машины",
    });
    const weeklyDefault = mirrorPolicy({
      id: "weekly-default",
      itemId: item.id,
      recurrenceRule: "weekly:MO@09:00",
      intervalMinutes: null,
      metadata: {},
    });
    const oneDay = mirrorPolicy({
      id: "one-day-window",
      itemId: item.id,
      policyType: "nag_until_ack",
      recurrenceRule: null,
      startsAt: new Date("2026-06-14T14:49:00.000Z"),
      endsAt: new Date("2026-06-14T17:00:00.000Z"),
      nextFireAt: new Date("2026-06-15T06:00:00.000Z"),
      metadata: { activeWindowStart: "17:49", activeWindowEnd: "20:00" },
    });
    const fedotov = fedotovPolicy();
    const session = staleSession(item.id);
    repairMocks.listManageableItems.mockResolvedValue([item]);
    repairMocks.listActiveReminderPolicies.mockResolvedValue([weeklyDefault, oneDay, fedotov]);
    repairMocks.listPendingAgentActionsByTypes.mockResolvedValue([session]);

    const preview = await previewV2120ProductionRepair({ userId: "user", now });
    expect(preview).toEqual(
      expect.objectContaining({
        mirrorItemIds: [item.id],
        mirrorMalformedPolicyIds: ["weekly-default", "one-day-window"],
        fedotovBrokenPolicyIds: ["fedotov-policy"],
        staleSessionIds: [session.id],
        calendarObjectsToChange: 0,
        safeToApply: true,
      }),
    );

    const result = await applyV2120ProductionRepair({ userId: "user", now });
    expect(result.renamedItemIds).toEqual([item.id]);
    expect(result.targetPolicyIds).toEqual(["weekly-default"]);
    expect(result.replacedPolicyIds).toEqual(["one-day-window"]);
    expect(result.fedotovMovedToReviewIds).toEqual(["fedotov-policy"]);
    expect(result.clearedSessionIds).toEqual([session.id]);
    expect(result.calendarObjectsChanged).toBe(0);
    expect(repairMocks.updateReminderPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: "weekly-default",
        recurrenceRule: "weekly:MO@08:00",
        intervalMinutes: 60,
        requireAck: true,
      }),
    );
    expect(repairMocks.updateReminderPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: "fedotov-policy",
        status: "paused",
        nextFireAt: null,
        metadata: expect.objectContaining({ hiddenFromDashboard: true, needsReview: true }),
      }),
    );
    expect(repairMocks.materializeNextPolicyReminder).toHaveBeenCalledWith(
      expect.objectContaining({ id: "weekly-default" }),
      expect.any(Date),
      { now },
    );
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

function mirrorItem(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: "mirror-item",
    userId: "user",
    pendingActionId: null,
    kind: "recurring_task",
    status: "active",
    title: "Решить вопрос с зеркалом для машины",
    description: null,
    location: null,
    timezone,
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "recurring_car",
    visibility: "long_term",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: { recurrenceRule: "weekly:MO" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mirrorPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: "mirror-policy",
    userId: "user",
    itemId: "mirror-item",
    title: "Решить вопрос с зеркалом для машины",
    category: "recurring_car",
    policyType: "recurring",
    status: "active",
    timezone,
    startsAt: null,
    endsAt: null,
    nextFireAt: new Date("2026-06-15T05:00:00.000Z"),
    recurrenceRule: "weekly:MO@08:00",
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
    metadata: {
      activeWindowStart: "08:00",
      activeWindowEnd: "20:00",
      stopOnItemComplete: true,
      stopCondition: "until_done",
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fedotovPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: "fedotov-policy",
    userId: "user",
    itemId: null,
    title: "Напоминание о вопросе с оплатой Сергея Федотова",
    category: "finance",
    policyType: "nag_until_ack",
    status: "active",
    timezone,
    startsAt: new Date("2026-06-15T17:00:00.000Z"),
    endsAt: new Date("2026-06-15T23:59:00.000Z"),
    nextFireAt: new Date("2026-06-15T17:00:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: 300,
    requireAck: true,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "keep_open",
    snoozedUntil: null,
    snoozeScope: null,
    quietHours: null,
    escalationPolicy: null,
    metadata: { activeWindowStart: "20:00", activeWindowEnd: "02:59" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function staleSession(itemId: string): AgentAction {
  return {
    id: "stale-session",
    userId: "user",
    messageId: null,
    actionType: "reminder_policy_edit_session",
    status: "pending",
    input: { itemId },
    output: {},
    idempotencyKey: "stale-session",
    expiresAt: new Date("2026-06-15T00:00:00.000Z"),
    confirmedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
