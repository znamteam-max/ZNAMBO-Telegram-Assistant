import { describe, expect, it } from "vitest";

import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { buildUserTimelineViewFromData } from "@/services/userTimeline";

const now = new Date("2026-06-12T09:00:00.000Z");

describe("V2.5.3 canonical user timeline", () => {
  it("moves normal overdue work into overdue, not unresolved, and keeps every row editable", () => {
    const timeline = buildUserTimelineViewFromData({
      timezone: "Europe/Moscow",
      now,
      items: [
        item({ id: "old", title: "Составить расписание НХЛ", startAt: new Date("2026-06-09T05:00:00.000Z") }),
        item({ id: "soon", title: "Отвести Роба к ортодонту", kind: "event", startAt: new Date("2026-06-16T07:20:00.000Z") }),
      ],
      policies: [policy()],
    });

    expect(timeline.byBucket.overdue.map((row) => row.entityRef.id)).toEqual(["old"]);
    expect(timeline.byBucket.unresolvedPast.map((row) => row.entityRef.id)).toEqual([]);
    expect(timeline.byBucket.soon.map((row) => row.entityRef.id)).toContain("soon");
    expect(timeline.rows.every((row) => row.editable && row.entityRef.id)).toBe(true);
  });

  it("groups campaign policies into one canonical visible row", () => {
    const timeline = buildUserTimelineViewFromData({
      timezone: "Europe/Moscow",
      now,
      items: [],
      policies: [
        policy({ id: "p1", metadata: { campaignGroup: "central_park" } }),
        policy({
          id: "p2",
          metadata: { campaignGroup: "central_park" },
          nextFireAt: new Date("2026-06-13T07:00:00.000Z"),
        }),
      ],
    });
    expect(timeline.policies).toHaveLength(1);
    expect(timeline.rows[0].entityRef).toEqual({ type: "campaign", id: "central_park" });
  });

  it("clears stale carryover classification after an explicit reschedule to today", () => {
    const timeline = buildUserTimelineViewFromData({
      timezone: "Europe/Moscow",
      now,
      items: [
        item({
          id: "lenses",
          title: "Забрать линзы для Аси",
          dueAt: new Date("2026-06-12T16:00:00.000Z"),
          metadata: {
            untilDoneCarryover: true,
            carryoverLocalDate: "2026-06-11",
            carryoverMarkedAt: "2026-06-12T06:00:00.000Z",
          },
        }),
      ],
      policies: [],
    });

    const row = timeline.rows.find((candidate) => candidate.entityRef.id === "lenses");
    expect(row?.dateBucket).toBe("today");
    expect(row?.item?.metadata?.untilDoneCarryover).not.toBe(true);
    expect(timeline.byBucket.unresolvedPast).toHaveLength(0);
    expect(timeline.byBucket.today.map((candidate) => candidate.entityRef.id)).toContain("lenses");
  });

  it("keeps a genuinely unfinished task from yesterday in carryover", () => {
    const timeline = buildUserTimelineViewFromData({
      timezone: "Europe/Moscow",
      now,
      items: [
        item({
          id: "old-carryover",
          title: "Придумать интеграцию кэфов",
          dueAt: new Date("2026-06-11T20:59:00.000Z"),
          metadata: {
            untilDoneCarryover: true,
            carryoverLocalDate: "2026-06-11",
          },
        }),
      ],
      policies: [],
    });

    expect(timeline.byBucket.unresolvedPast.map((row) => row.entityRef.id)).toEqual([
      "old-carryover",
    ]);
  });
});

function item(overrides: Partial<PlannerItem>): PlannerItem {
  return {
    id: "item",
    userId: "user",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Task",
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: null,
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

function policy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: "policy",
    userId: "user",
    itemId: null,
    title: "ЖКХ",
    category: "recurring_finance",
    policyType: "long_term",
    status: "active",
    timezone: "Europe/Moscow",
    startsAt: null,
    endsAt: null,
    nextFireAt: new Date("2026-06-20T07:00:00.000Z"),
    recurrenceRule: "monthly",
    intervalMinutes: null,
    requireAck: true,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    quietHours: null,
    escalationPolicy: null,
    snoozedUntil: null,
    snoozeScope: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
