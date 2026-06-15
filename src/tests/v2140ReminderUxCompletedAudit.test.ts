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
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { parseRecurringPolicyIntents } from "@/domain/recurringPolicySemantics";
import { getIncompleteRecurringPolicies } from "@/services/recurringPolicyDraftSessions";
import { parseItemEditMutation } from "@/services/itemEditMutations";
import { findSimilarActiveRecurringPolicy } from "@/services/recurringPolicyDuplicateDetection";
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

  it("parses several before-event reminders for one event as additive policies", () => {
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
        mode: "add",
      }),
    );
    expect(
      mutation.reminderPolicy?.policyType === "before_event_multi"
        ? mutation.reminderPolicy.reminders.map((reminder) => reminder.label)
        : [],
    ).toEqual(["за день в 09:00", "за 2 часа", "за 30 минут"]);
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
