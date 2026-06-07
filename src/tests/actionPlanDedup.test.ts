import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionPlan } from "@/ai/schemas";
import type { PlannerItem } from "@/db/schema";

const mocks = vi.hoisted(() => ({
  listVisibleActivePlanItems: vi.fn(),
}));

vi.mock("@/db/queries/items", () => ({
  listVisibleActivePlanItems: mocks.listVisibleActivePlanItems,
}));

import { filterDuplicateActionPlan } from "@/services/actionPlanDedup";

describe("ActionPlan existing-item deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listVisibleActivePlanItems.mockResolvedValue([
      item("event-1", "Эфир ВС", "event", "2026-06-07T10:00:00.000Z"),
      item("training-1", "Тренировка Z2", "training", "2026-06-07T19:00:00.000Z"),
      item(
        "prep-1",
        "Подготовка к ЧМ",
        "preparation_task",
        "2026-06-07T19:00:00.000Z",
      ),
    ]);
  });

  it("keeps only the genuinely new preparation in a hybrid request", async () => {
    const result = await filterDuplicateActionPlan({
      userId: "user-id",
      timezone: "Europe/Moscow",
      plan: {
        intent: "plan",
        summary: null,
        reply: null,
        confidence: 0.95,
        requiresConfirmation: false,
        actions: [
          action("Эфир ВС", "event", "event", "2026-06-07T13:00:00"),
          action("Тренировка Z2", "training", "training", "2026-06-07T22:00:00"),
          action(
            "Подготовка к ЧМ",
            "preparation",
            "preparation_task",
            "2026-06-07T21:00:00",
          ),
        ],
        memoryCandidates: [],
        clarificationQuestions: [],
      },
    });

    expect(result.plan.actions).toEqual([]);
    expect(result.skippedItemIds).toEqual(["event-1", "training-1", "prep-1"]);
  });
});

function action(
  title: string,
  actionType: "event" | "training" | "preparation",
  kind: "event" | "training" | "preparation_task",
  startAtLocal: string,
): ActionPlan["actions"][number] {
  return {
    actionType,
    kind,
    title,
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAtLocal,
    endAtLocal: null,
    dueAtLocal: null,
    durationMinutes: 60,
    priority: 3,
    confidence: 0.95,
    risk: "low",
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: {},
  };
}

function item(
  id: string,
  title: string,
  kind: PlannerItem["kind"],
  startAt: string,
): PlannerItem {
  const now = new Date("2026-06-07T05:00:00.000Z");
  return {
    id,
    userId: "user-id",
    pendingActionId: null,
    kind,
    status: "active",
    title,
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: new Date(startAt),
    endAt: null,
    dueAt: null,
    completedAt: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
