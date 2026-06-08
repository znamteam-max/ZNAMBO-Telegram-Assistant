import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listActivePoliciesForReconciliation: vi.fn(),
  getPolicySlotState: vi.fn(),
  getPendingReminderForPolicy: vi.fn(),
  updateReminderPolicy: vi.fn(),
  expirePolicyAndCancelFutureReminders: vi.fn(),
  restorePolicyReminder: vi.fn(),
  materializeNextPolicyReminder: vi.fn(),
}));

vi.mock("@/db/queries/reminderPolicies", () => ({
  listActivePoliciesForReconciliation: mocks.listActivePoliciesForReconciliation,
  getPolicySlotState: mocks.getPolicySlotState,
  getPendingReminderForPolicy: mocks.getPendingReminderForPolicy,
  updateReminderPolicy: mocks.updateReminderPolicy,
  expirePolicyAndCancelFutureReminders: mocks.expirePolicyAndCancelFutureReminders,
}));
vi.mock("@/db/queries/reminders", () => ({
  restorePolicyReminder: mocks.restorePolicyReminder,
}));
vi.mock("@/services/reminderPolicyEngine", () => ({
  materializeNextPolicyReminder: mocks.materializeNextPolicyReminder,
}));

import { reconcileActiveReminderPolicies } from "@/services/reminderPolicyReconciler";

describe("V2.4.1 policy reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listActivePoliciesForReconciliation.mockResolvedValue([policy()]);
    mocks.updateReminderPolicy.mockResolvedValue(policy());
    mocks.materializeNextPolicyReminder.mockResolvedValue({ id: "reminder-id" });
    mocks.getPendingReminderForPolicy.mockResolvedValue(null);
  });

  it("materializes one missing pending reminder and stays idempotent", async () => {
    mocks.getPolicySlotState.mockResolvedValueOnce(null).mockResolvedValueOnce({
      occurrence: {
        policyId: "policy-id",
        scheduledFor: new Date("2026-06-08T06:30:00.000Z"),
      },
      reminder: { id: "reminder-id", status: "pending" },
    });

    const first = await reconcileActiveReminderPolicies({
      now: new Date("2026-06-08T06:20:00.000Z"),
    });
    const second = await reconcileActiveReminderPolicies({
      now: new Date("2026-06-08T06:21:00.000Z"),
    });

    expect(first.materialized).toBe(1);
    expect(second.materialized).toBe(0);
    expect(mocks.materializeNextPolicyReminder).toHaveBeenCalledTimes(1);
  });

  it("does not create a catch-up burst while an older reminder is still pending", async () => {
    mocks.getPendingReminderForPolicy.mockResolvedValue({
      id: "older-reminder",
      status: "pending",
      scheduledAt: new Date("2026-06-08T05:00:00.000Z"),
    });

    const result = await reconcileActiveReminderPolicies({
      now: new Date("2026-06-08T06:12:00.000Z"),
    });

    expect(result.materialized).toBe(0);
    expect(mocks.materializeNextPolicyReminder).not.toHaveBeenCalled();
  });

  it("expires an ended interval before considering pending reminders", async () => {
    mocks.listActivePoliciesForReconciliation.mockResolvedValue([
      policy({
        endsAt: new Date("2026-06-09T11:00:00.000Z"),
        onWindowEnd: "expire_silently",
      }),
    ]);
    mocks.getPendingReminderForPolicy.mockResolvedValue({
      id: "post-window-reminder",
      status: "pending",
      scheduledAt: new Date("2026-06-10T00:20:00.000Z"),
    });

    const result = await reconcileActiveReminderPolicies({
      now: new Date("2026-06-10T00:20:00.000Z"),
    });

    expect(result.expired).toBe(1);
    expect(mocks.expirePolicyAndCancelFutureReminders).toHaveBeenCalledOnce();
    expect(mocks.getPendingReminderForPolicy).not.toHaveBeenCalled();
    expect(mocks.materializeNextPolicyReminder).not.toHaveBeenCalled();
  });
});

function policy(overrides: Record<string, unknown> = {}) {
  return {
    id: "policy-id",
    userId: "user-id",
    itemId: "item-id",
    title: "Позвонить Дрик",
    category: "people",
    policyType: "interval_window",
    status: "active",
    timezone: "Europe/Moscow",
    startsAt: new Date("2026-06-08T05:00:00.000Z"),
    endsAt: new Date("2026-06-08T11:00:00.000Z"),
    nextFireAt: new Date("2026-06-08T06:30:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: 30,
    requireAck: true,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    quietHours: null,
    escalationPolicy: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
