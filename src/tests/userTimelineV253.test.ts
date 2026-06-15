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
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
