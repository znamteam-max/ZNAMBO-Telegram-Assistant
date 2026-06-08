import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPolicyForReminder: vi.fn(),
  markPolicyOccurrenceAcked: vi.fn(),
  updateReminderPolicy: vi.fn(),
}));

vi.mock("@/db/queries/reminderPolicies", () => ({
  attachOccurrenceReminder: vi.fn(),
  createPolicyOccurrence: vi.fn(),
  createReminderPolicyIfMissing: vi.fn(),
  getPolicyForReminder: mocks.getPolicyForReminder,
  markPolicyOccurrenceAcked: mocks.markPolicyOccurrenceAcked,
  markPolicyOccurrenceDelivered: vi.fn(),
  updateReminderPolicy: mocks.updateReminderPolicy,
}));
vi.mock("@/db/queries/reminders", () => ({
  createReminderIfMissing: vi.fn(),
}));
vi.mock("@/db/queries/users", () => ({
  getUserById: vi.fn(),
}));

import { acknowledgePolicyReminder } from "@/services/reminderPolicyEngine";

describe("V2.4.1 reminder policy acknowledgement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPolicyForReminder.mockResolvedValue({
      policy: {
        id: "policy-id",
        userId: "user-id",
        policyType: "interval_window",
      },
    });
    mocks.updateReminderPolicy.mockResolvedValue({
      id: "policy-id",
      status: "completed",
      nextFireAt: null,
    });
  });

  it("completes an interval policy and clears its next fire after Done", async () => {
    await acknowledgePolicyReminder("reminder-id");

    expect(mocks.markPolicyOccurrenceAcked).toHaveBeenCalledWith("reminder-id", false);
    expect(mocks.updateReminderPolicy).toHaveBeenCalledWith({
      policyId: "policy-id",
      userId: "user-id",
      status: "completed",
      nextFireAt: null,
    });
  });
});
