import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlannerItem } from "@/db/schema";

const mocks = vi.hoisted(() => ({
  listItemsByIds: vi.fn(),
  createReminderIfMissing: vi.fn(),
  mergePlannerItemMetadata: vi.fn(),
}));

vi.mock("@/db/queries/taskViewStates", () => ({
  listItemsByIds: mocks.listItemsByIds,
}));

vi.mock("@/db/queries/reminders", () => ({
  createReminderIfMissing: mocks.createReminderIfMissing,
}));

vi.mock("@/db/queries/items", () => ({
  mergePlannerItemMetadata: mocks.mergePlannerItemMetadata,
}));

import { applyAgentItemUpdates } from "@/services/agentItemUpdates";

describe("agent item update execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const event = makeItem();
    mocks.listItemsByIds.mockResolvedValue([event]);
    mocks.createReminderIfMissing
      .mockResolvedValueOnce({ id: "before-id" })
      .mockResolvedValueOnce({ id: "followup-id" });
    mocks.mergePlannerItemMetadata.mockResolvedValue(event);
  });

  it("executes reminder and follow-up tools against existing item ids", async () => {
    const result = await applyAgentItemUpdates({
      userId: "user-id",
      now: new Date("2026-06-07T05:00:00.000Z"),
      updates: [
        {
          itemIds: ["11111111-1111-4111-8111-111111111111"],
          reminderMinutesBefore: 60,
          followupMinutesAfter: 15,
          exposeManagementButtons: true,
          note: null,
        },
      ],
    });

    expect(mocks.createReminderIfMissing).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "event_before",
        scheduledAt: new Date("2026-06-07T09:00:00.000Z"),
      }),
    );
    expect(mocks.createReminderIfMissing).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "followup",
        scheduledAt: new Date("2026-06-07T11:15:00.000Z"),
      }),
    );
    expect(result.updatedItems).toHaveLength(1);
    expect(result.reminderIds).toEqual(["before-id", "followup-id"]);
    expect(result.exposeManagementButtons).toBe(true);
  });

  it("schedules a one-minute catch-up for a recently missed follow-up", async () => {
    mocks.createReminderIfMissing.mockReset();
    mocks.createReminderIfMissing.mockResolvedValue({ id: "catchup-id" });

    const result = await applyAgentItemUpdates({
      userId: "user-id",
      now: new Date("2026-06-07T12:00:00.000Z"),
      updates: [
        {
          itemIds: ["11111111-1111-4111-8111-111111111111"],
          reminderMinutesBefore: 60,
          followupMinutesAfter: 15,
          exposeManagementButtons: true,
          note: null,
        },
      ],
    });

    expect(mocks.createReminderIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "followup",
        scheduledAt: new Date("2026-06-07T12:01:00.000Z"),
        idempotencyKey:
          "11111111-1111-4111-8111-111111111111:agent-followup:15:2026-06-07T11:15:00.000Z",
      }),
    );
    expect(result.reminderIds).toEqual(["catchup-id"]);
    expect(result.warnings).toContain(
      "followup_catchup_scheduled:11111111-1111-4111-8111-111111111111",
    );
  });
});

function makeItem(): PlannerItem {
  const now = new Date("2026-06-07T05:00:00.000Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "user-id",
    pendingActionId: null,
    kind: "event",
    status: "active",
    title: "Красочный забег",
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: new Date("2026-06-07T10:00:00.000Z"),
    endAt: new Date("2026-06-07T11:00:00.000Z"),
    dueAt: null,
    completedAt: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
