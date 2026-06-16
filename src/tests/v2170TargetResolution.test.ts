import { describe, expect, it } from "vitest";

import type { AgentExecution } from "@/ai/schemas/agentExecution";
import { isReminderOnlyFollowup } from "@/bot/recentEventReminderFlow";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { formatDashboardItem } from "@/telegram/liveDashboard";
import { buildUserTimelineViewFromData } from "@/services/userTimeline";
import { extractProposedEventFromTargetedUpdate } from "@/services/eventTargetResolution";

const timezone = "Europe/Moscow";

describe("V2.17.0 target resolution and reminder hygiene", () => {
  it("detects targeted update ambiguity when text title differs from selected event", () => {
    const item = plannerItem({
      title: "Созвон с Винлайном по ЧМ",
      startAt: new Date("2026-06-17T12:30:00.000Z"),
      endAt: new Date("2026-06-17T13:30:00.000Z"),
    });
    const proposed = extractProposedEventFromTargetedUpdate({
      execution: execution({
        itemUpdates: [
          {
            itemIds: [item.id],
            operation: "configure",
            startAtLocal: null,
            endAtLocal: null,
            reminderMinutesBefore: 120,
            followupMinutesAfter: null,
            priority: null,
            exposeManagementButtons: true,
            note: null,
          },
        ],
        reminderPolicies: [
          {
            operation: "create_before_event_policy",
            itemIds: [item.id],
            itemTitle: item.title,
            title: item.title,
            category: "pre_event",
            policyType: "before_event",
            startsAtLocal: "2026-06-17T13:00:00",
            endsAtLocal: null,
            nextFireAtLocal: "2026-06-17T13:00:00",
            recurrenceRule: null,
            intervalMinutes: null,
            requireAck: false,
            maxOccurrences: null,
            minutesBefore: 30,
            windowEndInclusive: true,
            catchUpMode: "one_immediate_then_resume",
            onWindowEnd: "expire_silently",
            quietHoursStart: null,
            quietHoursEnd: null,
            allowDuringQuietHours: false,
          },
        ],
      }),
      text: "Созвон с Винлайном по ЦП завтра в 15.30. Напомни мне за два часа и за полчаса",
      item,
      timezone,
    });

    expect(proposed?.title).toBe("Созвон с Винлайном по ЦП");
    expect(proposed?.reminders.map((reminder) => reminder.minutesBefore).sort((a, b) => a - b)).toEqual([30, 120]);
  });

  it("treats bare offset lists as reminder follow-ups, but not event creation text", () => {
    expect(isReminderOnlyFollowup("За 3 часа, за 2 часа, за час")).toBe(true);
    expect(
      isReminderOnlyFollowup(
        "Созвон с Винлайном по ЦП завтра в 15.30. Напомни мне за два часа и за полчаса",
      ),
    ).toBe(false);
  });

  it("renders before-event reminders once and hides generic before-event noise", () => {
    const item = plannerItem({
      title: "Созвон с Винлайном по ЧМ",
      startAt: new Date("2026-06-17T12:30:00.000Z"),
      endAt: new Date("2026-06-17T13:30:00.000Z"),
    });
    const text = formatDashboardItem(item, timezone, null, true, [
      reminderPolicy({ itemId: item.id, metadata: { minutesBefore: 120 } }),
      reminderPolicy({ itemId: item.id, metadata: { minutesBefore: 120 } }),
      reminderPolicy({
        itemId: item.id,
        startsAt: new Date("2026-06-17T12:00:00.000Z"),
        nextFireAt: new Date("2026-06-17T12:00:00.000Z"),
        metadata: { minutesBefore: 30 },
      }),
      reminderPolicy({ itemId: item.id, startsAt: null, nextFireAt: null, metadata: {} }),
    ]);

    expect(text.match(/за 2 часа/g)?.length).toBe(1);
    expect(text).toContain("за 30 минут");
    expect(text).not.toContain("один раз");
  });

  it("moves ended important events into past-review bucket", () => {
    const item = plannerItem({
      title: "Студия Central Park",
      priority: 5,
      startAt: new Date("2026-06-16T07:00:00.000Z"),
      endAt: new Date("2026-06-16T08:00:00.000Z"),
      metadata: { important: true },
    });
    const timeline = buildUserTimelineViewFromData({
      items: [item],
      policies: [],
      timezone,
      now: new Date("2026-06-16T15:30:00.000Z"),
    });

    expect(timeline.byBucket.pastReview.map((row) => row.item?.id)).toEqual([item.id]);
    expect(timeline.byBucket.history.map((row) => row.item?.id)).not.toContain(item.id);
  });
});

function execution(overrides: Partial<AgentExecution> = {}): AgentExecution {
  return {
    intent: "update_existing_items",
    reply: null,
    actionPlan: null,
    viewScope: null,
    resetMode: null,
    itemUpdates: [],
    reminderPolicies: [],
    memoryFacts: [],
    clarificationQuestions: [],
    ...overrides,
  };
}

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
    timezone,
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
    timezone,
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
