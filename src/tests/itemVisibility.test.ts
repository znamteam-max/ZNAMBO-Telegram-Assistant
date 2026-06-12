import { describe, expect, it } from "vitest";

import type { PlannerItem } from "@/db/schema";
import {
  isGarbageOrTestItem,
  isOverdueCarryCandidate,
  isVisibleInDailyDigest,
  isVisibleInEveningReview,
} from "@/domain/itemVisibility";

const from = new Date("2026-06-07T00:00:00.000Z");
const to = new Date("2026-06-07T23:59:59.999Z");

describe("daily item visibility", () => {
  it("shows only active, non-test, non-garbage items inside the requested date", () => {
    expect(isVisibleInDailyDigest(makeItem({ dueAt: from }), from, to)).toBe(true);
    expect(isVisibleInDailyDigest(makeItem({ dueAt: new Date("2026-05-27T10:00:00.000Z") }), from, to)).toBe(false);
    expect(isVisibleInDailyDigest(makeItem({ dueAt: from, metadata: { isTest: true } }), from, to)).toBe(false);
    expect(isVisibleInDailyDigest(makeItem({ dueAt: from, status: "cancelled" }), from, to)).toBe(false);
  });

  it("uses the same strict current-day filter for evening review", () => {
    expect(isVisibleInEveningReview(makeItem({ startAt: from }), from, to)).toBe(true);
    expect(isVisibleInEveningReview(makeItem({ startAt: new Date("2026-06-08T10:00:00.000Z") }), from, to)).toBe(false);
  });

  it("allows yesterday carry only for non-event active work", () => {
    expect(isOverdueCarryCandidate(makeItem({ dueAt: from, kind: "task" }), from, to)).toBe(true);
    expect(isOverdueCarryCandidate(makeItem({ startAt: from, kind: "event" }), from, to)).toBe(false);
  });

  it("recognizes known polluted production titles", () => {
    expect(isGarbageOrTestItem(makeItem({ title: "Удали всё, давай заново" }))).toBe(true);
    expect(isGarbageOrTestItem(makeItem({ title: "Тестовое напоминание через 2 мин." }))).toBe(true);
    expect(isGarbageOrTestItem(makeItem({ title: "сделать его ." }))).toBe(true);
  });
});

function makeItem(overrides: Partial<PlannerItem>): PlannerItem {
  const now = new Date("2026-06-07T09:00:00.000Z");
  return {
    id: "item-id",
    userId: "user-id",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Today item",
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
