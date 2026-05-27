import { describe, expect, it } from "vitest";

import type { PlannerActionProposal } from "@/ai/schemas";
import {
  PendingActionService,
  type CreatedPlannerItemForService,
  type PendingActionForService,
  type PendingActionStore,
} from "@/domain/pendingActionService";
import type { MaterializedItem, MaterializedReminder } from "@/domain/types";

const proposal: PlannerActionProposal = {
  intent: "create_item",
  kind: "event",
  title: "Встреча с Winline",
  description: null,
  location: null,
  timezone: "Europe/Helsinki",
  startAtLocal: "2026-05-28T12:00:00",
  endAtLocal: null,
  dueAtLocal: null,
  durationMinutes: 60,
  priority: 3,
  reminderPresets: ["24h", "day_morning", "1h"],
  reply: null,
  requiresConfirmation: true,
  confidence: 0.9,
  memoryCandidates: [],
  preparationPrompt: null,
  disambiguationOptions: [],
};

class InMemoryPendingStore implements PendingActionStore {
  action: PendingActionForService = {
    id: "pending-1",
    userId: "user-1",
    status: "pending",
    expiresAt: new Date("2026-05-27T10:00:00.000Z"),
    payload: proposal,
  };

  item: CreatedPlannerItemForService | null = null;
  reminders: MaterializedReminder[] = [];

  async claimPendingAction(_pendingActionId: string, userId: string, now: Date) {
    if (this.item) return { status: "already_confirmed" as const, item: this.item };
    if (this.action.userId !== userId) return { status: "not_found" as const };
    if (this.action.status === "cancelled") return { status: "cancelled" as const };
    if (this.action.expiresAt <= now) return { status: "expired" as const };
    this.action.status = "confirmed";
    return { status: "claimed" as const, action: this.action };
  }

  async createItemWithReminders(params: {
    action: PendingActionForService;
    item: MaterializedItem;
    reminders: MaterializedReminder[];
  }) {
    this.item = { ...params.item, id: "item-1", pendingActionId: params.action.id };
    this.reminders = params.reminders;
    return { item: this.item, reminders: this.reminders };
  }
}

describe("pending action confirmation", () => {
  it("creates item and preset reminders exactly once", async () => {
    const store = new InMemoryPendingStore();
    const service = new PendingActionService(store);
    const now = new Date("2026-05-26T10:00:00.000Z");

    const first = await service.confirm({
      pendingActionId: "pending-1",
      userId: "user-1",
      timezone: "Europe/Helsinki",
      now,
    });
    const second = await service.confirm({
      pendingActionId: "pending-1",
      userId: "user-1",
      timezone: "Europe/Helsinki",
      now,
    });

    expect(first.status).toBe("created");
    if (first.status !== "created") throw new Error("Expected created result");
    expect(first.reminders).toHaveLength(3);
    expect(second.status).toBe("already_confirmed");
    expect(store.item?.title).toBe("Встреча с Winline");
  });

  it("rejects expired pending actions", async () => {
    const service = new PendingActionService(new InMemoryPendingStore());
    const result = await service.confirm({
      pendingActionId: "pending-1",
      userId: "user-1",
      timezone: "Europe/Helsinki",
      now: new Date("2026-05-28T10:00:00.000Z"),
    });
    expect(result.status).toBe("expired");
  });
});
