import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAllActiveItems: vi.fn(),
  cancelPlannerItemWithMetadata: vi.fn(),
  updatePlannerItemForReminderRepair: vi.fn(),
  createReminderPolicyIfMissing: vi.fn(),
  cancelLegacyRemindersWithoutPolicy: vi.fn(),
  reconcileActiveReminderPolicies: vi.fn(),
}));

vi.mock("@/db/queries/items", () => ({
  listAllActiveItems: mocks.listAllActiveItems,
  cancelPlannerItemWithMetadata: mocks.cancelPlannerItemWithMetadata,
  updatePlannerItemForReminderRepair: mocks.updatePlannerItemForReminderRepair,
}));
vi.mock("@/db/queries/reminderPolicies", () => ({
  createReminderPolicyIfMissing: mocks.createReminderPolicyIfMissing,
}));
vi.mock("@/db/queries/reminders", () => ({
  cancelLegacyRemindersWithoutPolicy: mocks.cancelLegacyRemindersWithoutPolicy,
}));
vi.mock("@/services/reminderPolicyReconciler", () => ({
  reconcileActiveReminderPolicies: mocks.reconcileActiveReminderPolicies,
}));

import { applyReminderPolicyRepair } from "@/services/reminderPolicyRepair";

describe("V2.4.1 legacy reminder repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAllActiveItems.mockResolvedValue([
      item("circle-main", "Кружок с анонсом винбокса"),
      item("circle-duplicate", "Регулярное напоминание о кружке с анонсом винбокса"),
      item("drik", "Позвонить Дрик по поводу Роба"),
      item("mirror", "Регулярное напоминание по поводу замены зеркала в автомобиле"),
      item("housing", "Регулярное напоминание по оплате ЖКХ"),
    ]);
    mocks.cancelPlannerItemWithMetadata.mockImplementation(async ({ itemId }) =>
      item(itemId, "archived"),
    );
    mocks.updatePlannerItemForReminderRepair.mockImplementation(async (input) => ({
      ...item(input.itemId, input.title),
      ...input,
    }));
    mocks.createReminderPolicyIfMissing.mockImplementation(async (input) => ({
      id: `policy-${input.itemId}`,
      ...input,
    }));
    mocks.reconcileActiveReminderPolicies.mockResolvedValue({
      checked: 4,
      materialized: 4,
      advanced: 0,
      expired: 0,
    });
  });

  it("repairs four groups, archives the circle duplicate, and creates policies", async () => {
    const result = await applyReminderPolicyRepair({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-08T06:12:00.000Z"),
    });

    expect(result.repairedItems).toHaveLength(4);
    expect(result.archivedItems).toHaveLength(1);
    expect(result.policyIds).toHaveLength(4);
    expect(mocks.createReminderPolicyIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "drik",
        policyType: "interval_window",
        intervalMinutes: 30,
        catchUpMode: "one_immediate_then_resume",
      }),
    );
    expect(mocks.createReminderPolicyIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "mirror",
        policyType: "long_term",
        recurrenceRule: "weekly",
      }),
    );
  });
});

function item(id: string, title: string) {
  return {
    id,
    userId: "user-id",
    pendingActionId: null,
    kind: "note",
    status: "active",
    title,
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
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
