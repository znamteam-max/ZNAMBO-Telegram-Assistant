import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlannerItem } from "@/db/schema";

const mocks = vi.hoisted(() => ({
  listItemsByIds: vi.fn(),
  createReminderIfMissing: vi.fn(),
  mergePlannerItemMetadata: vi.fn(),
  markPlannerItemCompleted: vi.fn(),
  updatePlannerItemSchedule: vi.fn(),
  cancelItemReminderChains: vi.fn(),
  listActiveRemindersForItems: vi.fn(),
  createReminderPolicyIfMissing: vi.fn(),
  stopPoliciesForItem: vi.fn(),
  materializeNextPolicyReminder: vi.fn(),
}));

vi.mock("@/db/queries/taskViewStates", () => ({
  listItemsByIds: mocks.listItemsByIds,
}));

vi.mock("@/db/queries/reminders", () => ({
  createReminderIfMissing: mocks.createReminderIfMissing,
  cancelItemReminderChains: mocks.cancelItemReminderChains,
  listActiveRemindersForItems: mocks.listActiveRemindersForItems,
}));

vi.mock("@/db/queries/items", () => ({
  mergePlannerItemMetadata: mocks.mergePlannerItemMetadata,
  markPlannerItemCompleted: mocks.markPlannerItemCompleted,
  updatePlannerItemSchedule: mocks.updatePlannerItemSchedule,
}));

vi.mock("@/db/queries/reminderPolicies", () => ({
  createReminderPolicyIfMissing: mocks.createReminderPolicyIfMissing,
  stopPoliciesForItem: mocks.stopPoliciesForItem,
}));

vi.mock("@/services/reminderPolicyEngine", () => ({
  materializeNextPolicyReminder: mocks.materializeNextPolicyReminder,
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
    mocks.markPlannerItemCompleted.mockResolvedValue({ ...event, status: "completed" });
    mocks.updatePlannerItemSchedule.mockResolvedValue(event);
    mocks.listActiveRemindersForItems.mockResolvedValue([]);
    mocks.cancelItemReminderChains.mockResolvedValue(undefined);
    mocks.stopPoliciesForItem.mockResolvedValue(undefined);
    mocks.createReminderPolicyIfMissing.mockImplementation(async (input) => ({
      id: input.policyType === "before_event" ? "before-policy" : "followup-policy",
      ...input,
    }));
    mocks.materializeNextPolicyReminder.mockImplementation(async (policy) => ({
      id: policy.policyType === "before_event" ? "before-id" : "followup-id",
    }));
  });

  it("executes reminder and follow-up tools against existing item ids", async () => {
    const result = await applyAgentItemUpdates({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T05:00:00.000Z"),
      updates: [
        {
          itemIds: ["11111111-1111-4111-8111-111111111111"],
          operation: "configure",
          startAtLocal: null,
          endAtLocal: null,
          reminderMinutesBefore: 60,
          followupMinutesAfter: 15,
          exposeManagementButtons: true,
          note: null,
        },
      ],
    });

    expect(mocks.createReminderPolicyIfMissing).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        policyType: "before_event",
        nextFireAt: new Date("2026-06-07T09:00:00.000Z"),
      }),
    );
    expect(mocks.createReminderPolicyIfMissing).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        policyType: "post_event_menu",
        nextFireAt: new Date("2026-06-07T11:15:00.000Z"),
      }),
    );
    expect(result.updatedItems).toHaveLength(1);
    expect(result.reminderIds).toEqual(["before-id", "followup-id"]);
    expect(result.exposeManagementButtons).toBe(true);
  });

  it("schedules a one-minute catch-up for a recently missed follow-up", async () => {
    mocks.materializeNextPolicyReminder.mockReset();
    mocks.materializeNextPolicyReminder.mockResolvedValue({ id: "catchup-id" });

    const result = await applyAgentItemUpdates({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T12:00:00.000Z"),
      updates: [
        {
          itemIds: ["11111111-1111-4111-8111-111111111111"],
          operation: "configure",
          startAtLocal: null,
          endAtLocal: null,
          reminderMinutesBefore: 60,
          followupMinutesAfter: 15,
          exposeManagementButtons: true,
          note: null,
        },
      ],
    });

    expect(mocks.createReminderPolicyIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        policyType: "post_event_menu",
        nextFireAt: new Date("2026-06-07T12:01:00.000Z"),
        idempotencyKey:
          "11111111-1111-4111-8111-111111111111:agent-followup:15:2026-06-07T11:15:00.000Z",
      }),
    );
    expect(result.reminderIds).toEqual(["catchup-id"]);
    expect(result.warnings).toContain(
      "followup_catchup_scheduled:11111111-1111-4111-8111-111111111111",
    );
  });

  it("completes only the explicitly referenced item and cancels its reminders", async () => {
    const result = await applyAgentItemUpdates({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T10:09:00.000Z"),
      updates: [
        {
          itemIds: ["11111111-1111-4111-8111-111111111111"],
          operation: "complete",
          startAtLocal: null,
          endAtLocal: null,
          reminderMinutesBefore: null,
          followupMinutesAfter: null,
          exposeManagementButtons: false,
          note: null,
        },
      ],
    });

    expect(mocks.markPlannerItemCompleted).toHaveBeenCalledWith(
      "user-id",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mocks.cancelItemReminderChains).toHaveBeenCalledWith("user-id", [
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(mocks.stopPoliciesForItem).toHaveBeenCalledWith(
      "user-id",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(result.completedItemIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("merges duplicate updates for one item and changes the range once", async () => {
    const updated = {
      ...makeItem(),
      startAt: new Date("2026-06-07T10:00:00.000Z"),
      endAt: new Date("2026-06-07T17:00:00.000Z"),
    };
    mocks.updatePlannerItemSchedule.mockResolvedValue(updated);

    const result = await applyAgentItemUpdates({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T09:00:00.000Z"),
      updates: [
        {
          itemIds: ["11111111-1111-4111-8111-111111111111"],
          operation: "reschedule",
          startAtLocal: "2026-06-07T13:00:00",
          endAtLocal: null,
          reminderMinutesBefore: null,
          followupMinutesAfter: null,
          exposeManagementButtons: false,
          note: null,
        },
        {
          itemIds: ["11111111-1111-4111-8111-111111111111"],
          operation: "reschedule",
          startAtLocal: null,
          endAtLocal: "2026-06-07T20:00:00",
          reminderMinutesBefore: null,
          followupMinutesAfter: null,
          exposeManagementButtons: true,
          note: null,
        },
      ],
    });

    expect(mocks.updatePlannerItemSchedule).toHaveBeenCalledTimes(1);
    expect(mocks.updatePlannerItemSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        startAt: new Date("2026-06-07T10:00:00.000Z"),
        endAt: new Date("2026-06-07T17:00:00.000Z"),
      }),
    );
    expect(result.updatedItems).toHaveLength(1);
    expect(result.rescheduledItemIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("blocks a proposed clock time that contradicts explicit user hours", async () => {
    const result = await applyAgentItemUpdates({
      userId: "user-id",
      timezone: "Europe/Moscow",
      sourceText: "Эфир ВС с 13 до 20 сделай",
      now: new Date("2026-06-07T09:00:00.000Z"),
      updates: [
        {
          itemIds: ["11111111-1111-4111-8111-111111111111"],
          operation: "reschedule",
          startAtLocal: "2026-06-07T10:00:00+03:00",
          endAtLocal: "2026-06-07T17:00:00+03:00",
          reminderMinutesBefore: null,
          followupMinutesAfter: null,
          exposeManagementButtons: true,
          note: null,
        },
      ],
    });

    expect(mocks.updatePlannerItemSchedule).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([
      "explicit_time_mismatch:11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("refuses to update a stale non-active item id", async () => {
    mocks.listItemsByIds.mockResolvedValue([{ ...makeItem(), status: "cancelled" }]);

    const result = await applyAgentItemUpdates({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T09:00:00.000Z"),
      updates: [
        {
          itemIds: ["11111111-1111-4111-8111-111111111111"],
          operation: "complete",
          startAtLocal: null,
          endAtLocal: null,
          reminderMinutesBefore: null,
          followupMinutesAfter: null,
          exposeManagementButtons: false,
          note: null,
        },
      ],
    });

    expect(mocks.markPlannerItemCompleted).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([
      "item_not_active:11111111-1111-4111-8111-111111111111",
    ]);
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
