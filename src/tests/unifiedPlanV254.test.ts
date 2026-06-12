import { describe, expect, it } from "vitest";

import {
  postCreateTriageKeyboard,
  reminderEmptyKeyboard,
  repeatPolicyDeleteKeyboard,
} from "@/bot/keyboards";
import type { PlannerItem } from "@/db/schema";
import { detectPlanConflicts } from "@/services/planConflicts";
import { buildUserTimelineViewFromData } from "@/services/userTimeline";

describe("V2.5.4 unified plan UX", () => {
  it("detects the Central Park and orthodontist overlap", () => {
    const studio = makeItem({
      id: "studio",
      kind: "event",
      title: "Студия Central Park",
      startAt: new Date("2026-06-16T05:00:00.000Z"),
      endAt: new Date("2026-06-16T09:00:00.000Z"),
    });
    const orthodontist = makeItem({
      id: "ortho",
      kind: "event",
      title: "Отвезти Роба к ортодонту",
      startAt: new Date("2026-06-16T07:20:00.000Z"),
    });

    const conflicts = detectPlanConflicts([studio, orthodontist]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].first.id).toBe("studio");
    expect(conflicts[0].second.id).toBe("ortho");
  });

  it("keeps tomorrow in the canonical timeline instead of hiding it in generic soon", () => {
    const item = makeItem({
      id: "tomorrow",
      title: "Рекап",
      startAt: new Date("2026-06-13T04:00:00.000Z"),
    });

    const timeline = buildUserTimelineViewFromData({
      items: [item],
      policies: [],
      timezone: "Europe/Moscow",
      now: new Date("2026-06-12T09:00:00.000Z"),
    });

    expect(timeline.byBucket.tomorrow.map((row) => row.item?.id)).toEqual(["tomorrow"]);
    expect(timeline.items.map((entry) => entry.id)).toEqual(["tomorrow"]);
  });

  it("provides post-create triage and reminder empty-state navigation", () => {
    const item = makeItem({ id: "created", title: "Эфир" });
    const triage = postCreateTriageKeyboard([item]).inline_keyboard.flat();
    const reminderEmpty = reminderEmptyKeyboard().inline_keyboard.flat();

    expect(triage.map((button) => button.text)).toEqual(
      expect.arrayContaining(["1", "⭐ Приоритеты", "🔔 Напоминания", "Оставить как есть"]),
    );
    expect(reminderEmpty.map((button) => button.text)).toEqual(
      expect.arrayContaining(["📋 План", "🧾 Задачи", "➕ Добавить напоминание"]),
    );
  });

  it("asks whether to delete only a repeat rule or the whole task", () => {
    const buttons = repeatPolicyDeleteKeyboard("policy-id", "item-id").inline_keyboard.flat();

    expect(buttons.map((button) => button.text)).toEqual(
      expect.arrayContaining(["Только правило", "Задачу и правило", "Отмена"]),
    );
  });
});

function makeItem(
  overrides: Partial<PlannerItem> & Pick<PlannerItem, "id" | "title">,
): PlannerItem {
  const now = new Date("2026-06-12T08:00:00.000Z");
  return {
    userId: "user-id",
    pendingActionId: null,
    kind: "task",
    status: "active",
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    priority: 3,
    category: null,
    source: "telegram",
    visibility: "active",
    sourcePolicyId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
