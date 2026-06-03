import { describe, expect, it } from "vitest";

import { decideJarvisTurn } from "@/agent/jarvisDecision";
import { parseDisplayIndexSelection } from "@/agent/jarvisTools";
import { itemIdsForDisplayIndices } from "@/agent/state/taskViewState";
import { isLikelyGarbagePlannerItem } from "@/agent/validation/antiGarbageValidator";
import type { PlannerItem, TaskViewState } from "@/db/schema";

describe("Jarvis Mode decision and view-state safety", () => {
  it("does not create a task for full-plan requests", () => {
    const decision = decideJarvisTurn("Дай план целиком");

    expect(decision.intent).toBe("render_full_plan");
    expect(decision.shouldCreateItems).toBe(false);
    expect(decision.toolName).toBe("render_schedule_view");
  });

  it("routes delete ranges to task-view tools, not planner creation", () => {
    const decision = decideJarvisTurn("удалить 7-12 и 14");

    expect(decision.intent).toBe("delete_by_indices");
    expect(decision.shouldCreateItems).toBe(false);
    expect(parseDisplayIndexSelection("удалить 7-12 и 14")).toEqual([7, 8, 9, 10, 11, 12, 14]);
  });

  it("opens yesterday review without creating a new item", () => {
    const decision = decideJarvisTurn("Хочу отметить что выполнено вчера");

    expect(decision.intent).toBe("render_yesterday_review");
    expect(decision.mode).toBe("review");
    expect(decision.shouldCreateItems).toBe(false);
  });

  it("delegates real multi-action capture to the existing V2 planner", () => {
    const decision = decideJarvisTurn(
      "Сегодня в 19:00 запись Больше Zoom. В 18:30 напомни начать всё настраивать. После записи хочу сделать часовой велосипед Z2.",
    );

    expect(decision.intent).toBe("delegate_to_planner");
    expect(decision.shouldCreateItems).toBe(true);
  });

  it("resolves display numbers from the latest saved task view", () => {
    const viewState = {
      itemsSnapshot: [
        { displayIndex: 1, itemId: "item-1" },
        { displayIndex: 2, itemId: "item-2" },
        { displayIndex: 7, itemId: "item-7" },
      ],
    } as TaskViewState;

    expect(itemIdsForDisplayIndices(viewState, [2, 7, 99])).toEqual(["item-2", "item-7"]);
  });

  it("detects debug and command-like garbage items", () => {
    expect(isLikelyGarbagePlannerItem(makeItem("Тестовое напоминание через 2 мин.", { debug: true }))).toBe(true);
    expect(isLikelyGarbagePlannerItem(makeItem("Дай план целиком"))).toBe(true);
    expect(isLikelyGarbagePlannerItem(makeItem("Запись Больше Zoom"))).toBe(false);
  });
});

function makeItem(title: string, metadata: Record<string, unknown> = {}): PlannerItem {
  const now = new Date("2026-06-03T09:00:00.000Z");
  return {
    id: `item-${title}`,
    userId: "user-id",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title,
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    priority: 3,
    source: "telegram",
    metadata,
    createdAt: now,
    updatedAt: now,
  };
}
