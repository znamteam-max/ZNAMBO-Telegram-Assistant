import { describe, expect, it } from "vitest";

import {
  classifyTimelineItem,
  compareTimelineEntries,
  getEffectivePriority,
} from "@/domain/timelineClassification";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";

const now = new Date("2026-06-10T16:00:00.000Z");

describe("V2.5.1 timeline classification and priority", () => {
  it("classifies an hourly today policy as active nag, not long term", () => {
    expect(
      classifyTimelineItem(
        {
          policy: policy({
            policyType: "interval_window",
            startsAt: new Date("2026-06-10T10:00:00.000Z"),
            endsAt: new Date("2026-06-10T20:00:00.000Z"),
          }),
        },
        now,
        "Europe/Moscow",
      ),
    ).toBe("active_nag");
  });

  it("classifies a weekly future policy as long term even when it is next week", () => {
    expect(
      classifyTimelineItem(
        {
          policy: policy({
            policyType: "long_term",
            category: "recurring_car",
            nextFireAt: new Date("2026-06-16T06:00:00.000Z"),
          }),
        },
        now,
        "Europe/Moscow",
      ),
    ).toBe("long_term");
  });

  it("keeps a weekly policy long term even when its next occurrence is tomorrow", () => {
    expect(
      classifyTimelineItem(
        {
          policy: policy({
            policyType: "recurring",
            recurrenceRule: "weekly",
            nextFireAt: new Date("2026-06-11T06:00:00.000Z"),
          }),
        },
        now,
        "Europe/Moscow",
      ),
    ).toBe("long_term");
  });

  it("raises effective priority near due time and sorts distant items by priority", () => {
    const urgent = item({
      priority: 3,
      dueAt: new Date("2026-06-10T18:00:00.000Z"),
    });
    const distantImportant = item({
      id: "important",
      priority: 5,
      dueAt: new Date("2026-06-20T18:00:00.000Z"),
    });
    const distantLow = item({
      id: "low",
      priority: 1,
      dueAt: new Date("2026-06-12T18:00:00.000Z"),
    });

    expect(getEffectivePriority({ item: urgent }, now, "Europe/Moscow")).toBe(5);
    expect(
      [distantLow, distantImportant].sort((a, b) =>
        compareTimelineEntries({ item: a }, { item: b }, now, "Europe/Moscow"),
      )[0]?.id,
    ).toBe("important");
  });

  it("keeps a dormant campaign item out of active sections", () => {
    expect(
      classifyTimelineItem(
        { item: item({ metadata: { campaignState: "waiting" } }) },
        now,
        "Europe/Moscow",
      ),
    ).toBe("campaign_waiting");
  });
});

function item(overrides: Partial<PlannerItem> = {}): PlannerItem {
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
    dueAt: new Date("2026-06-20T18:00:00.000Z"),
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
    title: "Policy",
    category: "today_focus",
    policyType: "one_time",
    status: "active",
    timezone: "Europe/Moscow",
    startsAt: null,
    endsAt: null,
    nextFireAt: new Date("2026-06-20T18:00:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: null,
    requireAck: false,
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
