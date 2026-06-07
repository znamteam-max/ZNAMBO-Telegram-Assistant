import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlannerItem } from "@/db/schema";

const mocks = vi.hoisted(() => ({
  getAgentActionById: vi.fn(),
  recordAgentAction: vi.fn(),
  updateAgentAction: vi.fn(),
  cancelCalendarSyncJobsForItem: vi.fn(),
  cancelPlannerItemWithMetadata: vi.fn(),
  listAllActiveItems: vi.fn(),
  cancelItemReminderChains: vi.fn(),
  listActiveRemindersForItems: vi.fn(),
}));

vi.mock("@/db/queries/agentActions", () => ({
  getAgentActionById: mocks.getAgentActionById,
  recordAgentAction: mocks.recordAgentAction,
  updateAgentAction: mocks.updateAgentAction,
}));

vi.mock("@/db/queries/items", () => ({
  cancelCalendarSyncJobsForItem: mocks.cancelCalendarSyncJobsForItem,
  cancelPlannerItemWithMetadata: mocks.cancelPlannerItemWithMetadata,
  listAllActiveItems: mocks.listAllActiveItems,
}));

vi.mock("@/db/queries/reminders", () => ({
  cancelItemReminderChains: mocks.cancelItemReminderChains,
  listActiveRemindersForItems: mocks.listActiveRemindersForItems,
}));

import { executeActivePlanReset, prepareActivePlanReset } from "@/services/activePlanReset";

describe("active plan reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const task = makeItem("task-id", "Task", "task");
    const recurring = makeItem("recurring-id", "Recurring", "recurring_task");
    mocks.listAllActiveItems.mockResolvedValue([task, recurring]);
    mocks.listActiveRemindersForItems.mockResolvedValue([
      { id: "reminder-id", status: "pending", scheduledAt: new Date("2026-06-08T09:00:00.000Z") },
    ]);
    mocks.recordAgentAction.mockResolvedValue({ id: "action-id", status: "pending" });
    mocks.getAgentActionById.mockResolvedValue({ id: "action-id", status: "pending" });
    mocks.cancelPlannerItemWithMetadata.mockImplementation(async ({ itemId }: { itemId: string }) =>
      itemId === task.id ? { ...task, status: "cancelled" } : null,
    );
    mocks.updateAgentAction.mockResolvedValue({ id: "action-id", status: "completed" });
  });

  it("previews then archives open non-recurring items and their reminder chains", async () => {
    const prepared = await prepareActivePlanReset({ userId: "user-id", mode: "all" });
    expect(prepared.preview.openItemCount).toBe(2);
    expect(prepared.preview.resettableItemCount).toBe(1);
    expect(prepared.preview.recurringPreservedCount).toBe(1);

    const result = await executeActivePlanReset({
      userId: "user-id",
      actionId: "action-id",
      mode: "all",
    });

    expect(result.items.map((item) => item.id)).toEqual(["task-id"]);
    expect(mocks.cancelItemReminderChains).toHaveBeenCalledWith("user-id", ["task-id"]);
    expect(mocks.cancelCalendarSyncJobsForItem).toHaveBeenCalledWith("task-id");
    expect(mocks.updateAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "action-id",
        status: "completed",
        undoPayload: expect.objectContaining({
          items: expect.any(Array),
          reminders: expect.any(Array),
        }),
      }),
    );
  });
});

function makeItem(id: string, title: string, kind: string): PlannerItem {
  const now = new Date("2026-06-07T09:00:00.000Z");
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
    startAt: null,
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
