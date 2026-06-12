import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadLatestTaskView: vi.fn(),
  listItemsByIds: vi.fn(),
  rememberAgentAction: vi.fn(),
  cancelPlannerItem: vi.fn(),
  cancelItemReminders: vi.fn(),
  cancelCalendarSyncJobsForItem: vi.fn(),
}));

vi.mock("@/agent/state/taskViewState", () => ({
  loadLatestTaskView: mocks.loadLatestTaskView,
  itemIdsForDisplayIndices: (
    view: { itemsSnapshot?: Array<{ displayIndex: number; itemId: string }> } | null,
    indices: number[],
  ) =>
    (view?.itemsSnapshot ?? [])
      .filter((entry) => indices.includes(entry.displayIndex))
      .map((entry) => entry.itemId),
}));
vi.mock("@/agent/state/actionHistory", () => ({
  rememberAgentAction: mocks.rememberAgentAction,
  loadLatestUndoableAgentAction: vi.fn(),
}));
vi.mock("@/db/queries/taskViewStates", () => ({
  listItemsByIds: mocks.listItemsByIds,
}));
vi.mock("@/db/queries/items", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/queries/items")>();
  return {
    ...actual,
    cancelPlannerItem: mocks.cancelPlannerItem,
    cancelCalendarSyncJobsForItem: mocks.cancelCalendarSyncJobsForItem,
  };
});
vi.mock("@/db/queries/reminders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/queries/reminders")>();
  return { ...actual, cancelItemReminders: mocks.cancelItemReminders };
});

import { deleteItemsByIndicesTool } from "@/agent/jarvisTools";
import type { PlannerItem, TaskViewState } from "@/db/schema";

describe("V2.5.4 safe numbered mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadLatestTaskView.mockResolvedValue({
      id: "current-view",
      itemsSnapshot: [
        { displayIndex: 4, itemId: "item-4" },
        { displayIndex: 5, itemId: "item-5" },
        { displayIndex: 6, itemId: "item-6" },
        { displayIndex: 7, itemId: "item-7" },
        { displayIndex: 8, itemId: "item-8" },
      ],
    } as TaskViewState);
    mocks.listItemsByIds.mockImplementation(
      async (_userId: string, ids: string[]) =>
        ids.map((id) => makeItem(id, `Запись ${id.slice(-1)}`)),
    );
    mocks.rememberAgentAction.mockResolvedValue({ id: "preview-action" });
  });

  it("creates a current-view preview without deleting anything", async () => {
    const result = await deleteItemsByIndicesTool({
      userId: "user-id",
      timezone: "Europe/Moscow",
      text: "Удали 5,6,7,8 поменяй 4 время на 10.00-11.00",
    });

    expect(result.reply).toContain("Подтвердить?");
    expect(result.reply).toContain("4. Запись 4 → 10:00–11:00");
    expect(mocks.rememberAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "numbered_mutation_preview",
        status: "pending",
        input: expect.objectContaining({ indices: [5, 6, 7, 8] }),
        output: expect.objectContaining({ viewStateId: "current-view" }),
      }),
    );
    expect(mocks.cancelPlannerItem).not.toHaveBeenCalled();
    expect(mocks.cancelItemReminders).not.toHaveBeenCalled();
    expect(mocks.cancelCalendarSyncJobsForItem).not.toHaveBeenCalled();
    expect(mocks.loadLatestTaskView).toHaveBeenCalledTimes(1);
  });

  it("does not search another view when an index is absent", async () => {
    const result = await deleteItemsByIndicesTool({
      userId: "user-id",
      timezone: "Europe/Moscow",
      text: "Удалить 99",
    });

    expect(result.status).toBe("noop");
    expect(result.reply).toContain("Не нашел номера из последнего списка");
    expect(mocks.loadLatestTaskView).toHaveBeenCalled();
    expect(mocks.listItemsByIds).toHaveBeenCalledWith("user-id", []);
  });
});

function makeItem(id: string, title: string): PlannerItem {
  const now = new Date("2026-06-12T08:00:00.000Z");
  return {
    id,
    userId: "user-id",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title,
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: new Date("2026-06-16T07:20:00.000Z"),
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
  };
}
