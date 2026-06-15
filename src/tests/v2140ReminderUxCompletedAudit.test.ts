import { beforeEach, describe, expect, it, vi } from "vitest";

const duplicateMocks = vi.hoisted(() => ({
  listActiveReminderPolicies: vi.fn(),
  updateReminderPolicy: vi.fn(),
}));

vi.mock("@/db/queries/reminderPolicies", () => ({
  listActiveReminderPolicies: duplicateMocks.listActiveReminderPolicies,
  updateReminderPolicy: duplicateMocks.updateReminderPolicy,
}));

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { agentExecutionSchema, type AgentReminderPolicy } from "@/ai/schemas/agentExecution";
import { normalizeAgentActionOutputForStatus } from "@/db/queries/agentActions";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";
import { hardenAgentTraceDetails } from "@/domain/agentTraceHygiene";
import { parseRecurringPolicyIntents } from "@/domain/recurringPolicySemantics";
import { formatHumanReminderPolicy } from "@/domain/reminderPolicyPresentation";
import {
  cleanupPreviewKeyboard,
  itemMenuKeyboard,
  reminderPolicyMenuKeyboard,
} from "@/bot/keyboards";
import {
  isCleanupEligibleBrokenPolicy,
  isCleanupEligibleCompleted,
  isCleanupEligibleDraft,
} from "@/services/cleanupPreview";
import { getIncompleteRecurringPolicies } from "@/services/recurringPolicyDraftSessions";
import { parseItemEditMutation } from "@/services/itemEditMutations";
import { findSimilarActiveRecurringPolicy } from "@/services/recurringPolicyDuplicateDetection";
import { normalizeAgentActionOutputForLog } from "@/services/actionLog";
import { buildUserTimelineViewFromData } from "@/services/userTimeline";
import { formatDashboardItem } from "@/telegram/liveDashboard";

const timezone = "Europe/Moscow";
const now = new Date("2026-06-15T09:00:00.000Z");

describe("V2.14.0 reminder UX, completed and audit hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    duplicateMocks.listActiveReminderPolicies.mockResolvedValue([]);
  });

  it.each([
    "Напоминай мне каждый понедельник решать вопрос о замене зеркала на машине",
    "Каждый понедельник напоминай решить вопрос с зеркалом",
    "По понедельникам напоминай поменять зеркало на машине",
    "Каждый понедельник надо проверить зеркало на машине",
  ])("turns weekly mirror request without time into a typed draft intent: %s", (text) => {
    const [intent] = parseRecurringPolicyIntents(text);
    expect(intent).toEqual(
      expect.objectContaining({
        recurrenceRule: "weekly:MO",
        recurrenceKind: "weekly",
        missingFields: ["reminderTime"],
      }),
    );
    expect(intent.title.toLocaleLowerCase("ru")).toContain("зеркал");

    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text,
      timezone,
      now,
      activeContext: "none",
    });
    expect(execution.actionPlan?.actions[0]?.metadata?.timeUnspecified).toBe(true);
    expect(getIncompleteRecurringPolicies(execution.reminderPolicies)).toHaveLength(1);
  });

  it("detects a similar active recurring mirror policy before creating a duplicate", async () => {
    duplicateMocks.listActiveReminderPolicies.mockResolvedValue([
      reminderPolicy({
        title: "Решить вопрос с зеркалом",
        policyType: "recurring",
        recurrenceRule: "weekly:MO@09:00",
      }),
    ]);
    const match = await findSimilarActiveRecurringPolicy({
      userId: "user",
      policies: [
        recurringProposal({
          title: "Решить вопрос о замене зеркала на машине",
          recurrenceRule: "weekly:MO",
        }),
      ],
    });
    expect(match?.existing.title).toBe("Решить вопрос с зеркалом");
    expect(match?.recurrenceFamily).toBe("weekly:MO");
  });

  it("asks add versus replace when neutral multi-reminder text meets existing policies", () => {
    const mutation = parseItemEditMutation({
      text: "Напомни за день в 9 утра, за 2 часа и за 30 минут",
      item: plannerItem({
        kind: "event",
        title: "Ортодонт",
        startAt: new Date("2026-06-16T16:00:00.000Z"),
        endAt: new Date("2026-06-16T17:00:00.000Z"),
      }),
      timezone,
      now,
    });
    expect(mutation.reminderPolicy).toEqual(
      expect.objectContaining({
        policyType: "before_event_multi",
        mode: "ask",
      }),
    );
    expect(
      mutation.reminderPolicy?.policyType === "before_event_multi"
        ? mutation.reminderPolicy.reminders.map((reminder) => reminder.label)
        : [],
    ).toEqual(["за день в 09:00", "за 2 часа", "за 30 минут"]);
  });

  it.each([
    ["Добавь напоминания за 2 часа и за 30 минут", "add"],
    ["Замени напоминания: за 2 часа и за 30 минут", "replace"],
  ] as const)("parses explicit multi-reminder mode: %s", (text, mode) => {
    const mutation = parseItemEditMutation({
      text,
      item: plannerItem({
        kind: "event",
        title: "Ортодонт",
        startAt: new Date("2026-06-16T16:00:00.000Z"),
      }),
      timezone,
      now,
    });
    expect(
      mutation.reminderPolicy?.policyType === "before_event_multi"
        ? mutation.reminderPolicy.mode
        : null,
    ).toBe(mode);
  });

  it("renders multiple event reminders as one compact concrete line", () => {
    const item = plannerItem({
      kind: "event",
      title: "Ортодонт",
      startAt: new Date("2026-06-16T16:00:00.000Z"),
      endAt: new Date("2026-06-16T17:00:00.000Z"),
    });
    const text = formatDashboardItem(
      item,
      timezone,
      null,
      true,
      [
        reminderPolicy({
          itemId: item.id,
          policyType: "before_event",
          nextFireAt: new Date("2026-06-15T06:00:00.000Z"),
          metadata: { minutesBefore: 2040, relativeLabel: "за день в 09:00" },
        }),
        reminderPolicy({
          itemId: item.id,
          policyType: "before_event",
          nextFireAt: new Date("2026-06-16T14:00:00.000Z"),
          metadata: { minutesBefore: 120 },
        }),
        reminderPolicy({
          itemId: item.id,
          policyType: "before_event",
          nextFireAt: new Date("2026-06-16T15:30:00.000Z"),
          metadata: { minutesBefore: 30 },
        }),
      ],
      now,
    );
    expect(text).toContain("🔔 за день в 09:00, за 2 часа, за 30 минут");
    expect(text).not.toContain("до события");
  });

  it("classifies normal overdue tasks separately from unresolved broken data", () => {
    const overdue = plannerItem({
      id: "overdue",
      kind: "task",
      title: "Сдать документы",
      dueAt: new Date("2026-06-15T08:00:00.000Z"),
      metadata: {},
    });
    const broken = plannerItem({
      id: "broken",
      kind: "task",
      title: "Черновик без времени",
      dueAt: null,
      metadata: { needsReview: true, timeUnspecified: true },
    });
    const timeline = buildUserTimelineViewFromData({
      items: [overdue, broken],
      policies: [],
      timezone,
      now,
    });
    expect(timeline.byBucket.overdue.map((row) => row.entityRef.id)).toEqual(["overdue"]);
    expect(timeline.byBucket.unresolvedPast.map((row) => row.entityRef.id)).toEqual(["broken"]);
  });

  it("keeps the reminder menu concrete and hides technical top-level labels", () => {
    const labels = reminderPolicyMenuKeyboard("item").inline_keyboard.flat().map((button) => button.text);
    expect(labels).toEqual(
      expect.arrayContaining([
        "⏰ В конкретное время",
        "📅 Перед событием",
        "🔁 Повторять",
        "➕ Несколько напоминаний",
      ]),
    );
    expect(labels).not.toEqual(
      expect.arrayContaining(["Один раз", "До события", "Тихие часы", "Категория", "Свои настройки"]),
    );
  });

  it("renders individual and remove-all controls for event reminders", () => {
    const policies = [
      reminderPolicy({ id: "p1", metadata: { minutesBefore: 120 } }),
      reminderPolicy({ id: "p2", metadata: { minutesBefore: 30 } }),
    ];
    const buttons = itemMenuKeyboard("item", null, null, false, policies).inline_keyboard.flat();
    expect(buttons.map((button) => button.text)).toEqual(
      expect.arrayContaining([
        "Удалить напоминание 1",
        "Удалить напоминание 2",
        "Удалить все напоминания",
      ]),
    );
    expect(buttons.map((button) => button.callback_data)).toEqual(
      expect.arrayContaining([
        "item_policy:cancel:item:p1",
        "item_policy:cancel:item:p2",
        "item_policy:cancel_all_before:item",
      ]),
    );
  });

  it("shows cleanup categories and requires category preview before confirmation", () => {
    const buttons = cleanupPreviewKeyboard("42", {
      messages: 3,
      completed: 2,
      drafts: 1,
      broken: 1,
      all: 7,
    }).inline_keyboard.flat();
    expect(buttons.map((button) => button.callback_data)).toEqual(
      expect.arrayContaining([
        "cleanup:preview:messages:chat:42",
        "cleanup:preview:completed:chat:42",
        "cleanup:preview:drafts:chat:42",
        "cleanup:preview:broken:chat:42",
        "cleanup:preview:all:chat:42",
      ]),
    );
    expect(buttons.some((button) => button.callback_data?.startsWith("cleanup:confirm:"))).toBe(false);
  });

  it("selects only conservative cleanup candidates", () => {
    expect(
      isCleanupEligibleCompleted(
        plannerItem({
          status: "completed",
          completedAt: new Date("2026-05-01T09:00:00.000Z"),
        }),
        now,
      ),
    ).toBe(true);
    expect(
      isCleanupEligibleCompleted(
        plannerItem({
          status: "completed",
          visibility: "history",
          completedAt: new Date("2026-05-01T09:00:00.000Z"),
        }),
        now,
      ),
    ).toBe(false);
    expect(
      isCleanupEligibleDraft(
        agentAction({
          actionType: "recurring_policy_draft",
          status: "pending",
          output: { expiresAt: "2026-06-15T08:00:00.000Z" },
        }),
        now,
      ),
    ).toBe(true);
    expect(
      isCleanupEligibleBrokenPolicy(
        reminderPolicy({ metadata: { needsReview: true } }),
      ),
    ).toBe(true);
    expect(isCleanupEligibleBrokenPolicy(reminderPolicy())).toBe(false);
  });

  it("renders unknown event offsets as review-required instead of a vague normal reminder", () => {
    const text = formatHumanReminderPolicy(
      reminderPolicy({ nextFireAt: null, startsAt: null, metadata: {} }),
      timezone,
    );
    expect(text).toContain("нужно уточнить время");
    expect(text).not.toBe("перед событием");
  });

  it("hardens failed traces with actionable non-empty diagnostics", () => {
    const details = hardenAgentTraceDetails({
      finalAction: "agent_execution_failed_closed",
      errorCode: "user_error",
      toolFailureReason: null,
      toolFailureField: null,
      suggestedNextPrompt: null,
    });
    expect(details.toolFailureReason).toBe("user_error");
    expect(details.toolFailureField).toBe("not_applicable");
    expect(String(details.suggestedNextPrompt)).not.toBe("");
  });

  it("never exposes committed and cancelled state markers together", () => {
    const output = {
      committedAt: "2026-06-15T10:00:00.000Z",
      cancelledAt: "2026-06-15T10:01:00.000Z",
      cancelledReason: "user_cancelled",
      createdPolicyIds: ["p1", "p2", "p3"],
    };
    const stored = normalizeAgentActionOutputForStatus("completed", output);
    const logged = normalizeAgentActionOutputForLog("completed", output);
    expect(stored.cancelledAt).toBeUndefined();
    expect(stored.cancelledReason).toBeUndefined();
    expect(logged.cancelledAt).toBeUndefined();
    expect(logged.createdPolicyIds).toEqual(["p1", "p2", "p3"]);
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

function recurringProposal(overrides: Partial<AgentReminderPolicy> = {}): AgentReminderPolicy {
  return {
    operation: "create_recurring_policy",
    itemIds: [],
    itemTitle: null,
    title: "Решить вопрос с зеркалом",
    category: "recurring_car",
    policyType: "recurring",
    startsAtLocal: null,
    endsAtLocal: null,
    nextFireAtLocal: null,
    recurrenceRule: "weekly:MO",
    intervalMinutes: null,
    requireAck: false,
    maxOccurrences: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
    ...overrides,
  };
}

function plannerItem(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: "item",
    userId: "user",
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
    category: "today_focus",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function reminderPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: "policy",
    userId: "user",
    itemId: "item",
    title: "Напоминание",
    category: "pre_event",
    policyType: "before_event",
    status: "active",
    timezone,
    startsAt: null,
    endsAt: null,
    nextFireAt: null,
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function agentAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: "action",
    userId: "user",
    sourceMessageId: null,
    actionType: "recurring_policy_draft",
    status: "pending",
    input: {},
    output: {},
    undoPayload: {},
    createdAt: now,
    ...overrides,
  };
}
