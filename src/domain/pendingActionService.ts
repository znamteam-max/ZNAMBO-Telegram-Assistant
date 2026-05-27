import type { PlannerActionProposal } from "@/ai/schemas";

import { materializeProposal } from "./itemService";
import type { MaterializedItem, MaterializedReminder } from "./types";

export type PendingActionForService = {
  id: string;
  userId: string;
  status: "pending" | "confirmed" | "cancelled";
  expiresAt: Date;
  payload: PlannerActionProposal;
};

export type CreatedPlannerItemForService = MaterializedItem & {
  id: string;
  pendingActionId: string;
};

export type PendingActionStore = {
  claimPendingAction(
    pendingActionId: string,
    userId: string,
    now: Date,
  ): Promise<
    | { status: "claimed"; action: PendingActionForService }
    | { status: "already_confirmed"; item: CreatedPlannerItemForService }
    | { status: "expired" | "not_found" | "cancelled" }
  >;
  createItemWithReminders(params: {
    action: PendingActionForService;
    item: MaterializedItem;
    reminders: MaterializedReminder[];
  }): Promise<{ item: CreatedPlannerItemForService; reminders: MaterializedReminder[] }>;
};

export class PendingActionService {
  constructor(private readonly store: PendingActionStore) {}

  async confirm(params: { pendingActionId: string; userId: string; timezone: string; now: Date }) {
    const claim = await this.store.claimPendingAction(
      params.pendingActionId,
      params.userId,
      params.now,
    );
    if (claim.status !== "claimed") return claim;

    const materialized = materializeProposal({
      proposal: claim.action.payload,
      userTimezone: params.timezone,
      now: params.now,
    });
    return {
      status: "created" as const,
      ...(await this.store.createItemWithReminders({
        action: claim.action,
        item: materialized.item,
        reminders: materialized.reminders,
      })),
    };
  }
}
