import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import {
  formatBeforeEventOffset,
  formatDedupedBeforeEventPolicies,
} from "@/domain/reminderPolicyPresentation";
import { parsePinnedContextIntent } from "@/domain/pinnedContextNotes";
import { parseScheduledCreationIntent } from "@/domain/scheduledCreationIntent";
import { sanitizePlannerTitle } from "@/domain/titleSanitizer";
import { buildUserTimelineViewFromData } from "@/services/userTimeline";
import { monthlyDayRangeAuditKey } from "@/services/reminderPolicyReconciler";

const timezone = "Europe/Moscow";
const userId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-06-18T08:00:00.000Z");

describe("V2.23.0 creation priority, pinned notes, carryover and labels", () => {
  it("parses a new event with before-event reminders before target resolution can hijack it", () => {
    const intent = parseScheduledCreationIntent({
      text: "Массаж в 15.30, напомни за час и за полчаса до",
      timezone,
      now,
    });

    expect(intent).toEqual(
      expect.objectContaining({
        intent: "scheduled_creation",
        kind: "event",
        title: "Массаж",
        startLocal: "2026-06-18T15:30:00",
        endLocal: "2026-06-18T16:30:00",
        remindersSuppressedByUser: false,
      }),
    );
    expect(intent?.reminders.map((reminder) => reminder.minutesBefore).sort((a, b) => b - a)).toEqual([
      60,
      30,
    ]);
  });

  it("treats negative reminder wording as no reminders, not a missing reminder time", () => {
    const intent = parseScheduledCreationIntent({
      text: "Эфир шоу Централь Парк завтра с 10.00 до 11.00, без напоминаний",
      timezone,
      now,
    });

    expect(intent).toEqual(
      expect.objectContaining({
        title: "Эфир шоу Централь Парк",
        startLocal: "2026-06-19T10:00:00",
        endLocal: "2026-06-19T11:00:00",
        reminders: [],
        remindersSuppressedByUser: true,
      }),
    );
  });

  it("removes reminder policy text from titles", () => {
    expect(
      sanitizePlannerTitle(
        "Напомни мне сегодня купить зеркало для велосипеда. Напоминай мне каждый час до конца дня, пока я не отмечу.",
      ),
    ).toBe("Купить зеркало для велосипеда");
  });

  it("parses pinned car notes and natural car-location questions without creating tasks", () => {
    const create = parsePinnedContextIntent({
      text: "Отдельное напоминание: машину оставил на парковке за ВкусВиллом, ближе к клинике Рошаля.",
      timezone,
      now,
    });
    const query = parsePinnedContextIntent({ text: "Где машина?", timezone, now });

    expect(create).toEqual(
      expect.objectContaining({
        type: "create",
        category: "car_location",
        title: "Машина",
        body: "Парковка за ВкусВиллом, ближе к клинике Рошаля",
      }),
    );
    expect(query).toEqual({ type: "query", category: "car_location", query: "машина" });
  });

  it("moves unfinished yesterday until-done tasks to unresolved carryover instead of passive overdue", () => {
    const item = plannerItem({
      dueAt: new Date("2026-06-17T20:59:00.000Z"),
      metadata: { untilDone: true, timeScope: "today" },
    });
    const timeline = buildUserTimelineViewFromData({
      items: [item],
      policies: [],
      timezone,
      now,
    });

    expect(timeline.byBucket.overdue).toHaveLength(0);
    expect(timeline.byBucket.unresolvedPast).toHaveLength(1);
    expect(timeline.byBucket.unresolvedPast[0].item?.metadata?.untilDoneCarryover).toBe(true);
  });

  it("humanizes large before-event offsets and folds morning sets into one line", () => {
    expect(formatBeforeEventOffset(10080)).toBe("за неделю");
    expect(formatBeforeEventOffset(4320)).toBe("за 3 дня");
    expect(formatBeforeEventOffset(2880)).toBe("за 2 дня");
    expect(formatBeforeEventOffset(60)).toBe("за час");

    const item = plannerItem({
      kind: "event",
      startAt: new Date("2026-07-01T16:00:00.000Z"),
      endAt: new Date("2026-07-01T17:00:00.000Z"),
    });
    const line = formatDedupedBeforeEventPolicies(
      [
        reminderPolicy({ metadata: { minutesBefore: 10080 } }),
        reminderPolicy({ metadata: { minutesBefore: 4320 } }),
        reminderPolicy({ metadata: { minutesBefore: 2880 } }),
        reminderPolicy({
          startsAt: new Date("2026-07-01T05:00:00.000Z"),
          nextFireAt: new Date("2026-07-01T05:00:00.000Z"),
          metadata: { minutesBefore: 660, eventMorningSet: true },
        }),
        reminderPolicy({
          startsAt: new Date("2026-07-01T06:00:00.000Z"),
          nextFireAt: new Date("2026-07-01T06:00:00.000Z"),
          metadata: { minutesBefore: 600, eventMorningSet: true },
        }),
        reminderPolicy({
          startsAt: new Date("2026-07-01T07:00:00.000Z"),
          nextFireAt: new Date("2026-07-01T07:00:00.000Z"),
          metadata: { minutesBefore: 540, eventMorningSet: true },
        }),
      ],
      timezone,
      item,
    );

    expect(line).toContain("за неделю");
    expect(line).toContain("за 3 дня");
    expect(line).toContain("за 2 дня");
    expect(line).toContain("утром в день события: 08:00, 09:00, 10:00");
    expect(line).not.toMatch(/168 ч|72 ч|645 минут|165 минут/);
  });

  it("builds one monthly audit throttle key per policy and local occurrence date", () => {
    expect(
      monthlyDayRangeAuditKey(
        "policy-id",
        new Date("2026-06-18T09:00:00.000Z"),
      ),
    ).toBe("policy-id:2026-06-18");
  });
});

function plannerItem(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    userId,
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Решить вопрос с ЭЦП",
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
    createdAt: new Date("2026-06-17T07:00:00.000Z"),
    updatedAt: new Date("2026-06-17T07:00:00.000Z"),
    ...overrides,
  };
}

function reminderPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: overrides.id ?? randomUUID(),
    userId,
    itemId: "11111111-1111-4111-8111-111111111111",
    title: "Напоминание",
    category: "pre_event",
    policyType: "before_event",
    status: "active",
    timezone,
    startsAt: new Date("2026-06-24T16:00:00.000Z"),
    endsAt: null,
    nextFireAt: new Date("2026-06-24T16:00:00.000Z"),
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
    createdAt: new Date("2026-06-17T07:00:00.000Z"),
    updatedAt: new Date("2026-06-17T07:00:00.000Z"),
    ...overrides,
  };
}
