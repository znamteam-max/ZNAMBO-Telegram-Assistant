import {
  cancelPlannerItem,
  listCampaignItems,
  markPlannerItemCompleted,
  mergePlannerItemMetadata,
} from "@/db/queries/items";
import {
  listReminderPoliciesForCampaign,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import type { PlannerItem } from "@/db/schema";

export function requiresCampaignCompletionClarification(item: PlannerItem, now = new Date()) {
  const isCampaignItem = typeof item.metadata?.campaignGroup === "string";
  const anchor = item.startAt ?? item.dueAt;
  return isCampaignItem && Boolean(anchor && anchor > now);
}

export async function markCampaignPreparationDone(userId: string, itemId: string) {
  return mergePlannerItemMetadata({
    userId,
    itemId,
    metadata: { preparationDone: true, preparationDoneAt: new Date().toISOString() },
  });
}

export async function completeCampaignEventAndActivateNext(params: {
  userId: string;
  item: PlannerItem;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const completed = await markPlannerItemCompleted(params.userId, params.item.id);
  const group = String(params.item.metadata?.campaignGroup ?? "");
  if (!completed || !group) return { completed, activated: null };
  const items = await listCampaignItems(params.userId, group);
  const next = items.find(
    (item) => item.status === "active" && item.metadata?.campaignState === "waiting",
  );
  if (!next) return { completed, activated: null };
  const activated = await mergePlannerItemMetadata({
    userId: params.userId,
    itemId: next.id,
    metadata: {
      campaignState: "active",
      campaignActivatedAt: now.toISOString(),
      campaignActivatedBy: params.item.id,
    },
  });
  const policies = await listReminderPoliciesForCampaign(params.userId, group);
  for (const policy of policies.filter((entry) => entry.itemId === next.id)) {
    await updateReminderPolicy({
      policyId: policy.id,
      userId: params.userId,
      metadata: { campaignState: "active", campaignActivatedAt: now.toISOString() },
    });
  }
  return { completed, activated };
}

export async function updateCampaignState(params: {
  userId: string;
  campaignGroup: string;
  action: "activate" | "pause" | "resume" | "cancel";
}) {
  const [items, policies] = await Promise.all([
    listCampaignItems(params.userId, params.campaignGroup),
    listReminderPoliciesForCampaign(params.userId, params.campaignGroup),
  ]);
  if (params.action === "cancel") {
    for (const item of items.filter((entry) => entry.status === "active")) {
      await cancelPlannerItem(params.userId, item.id);
    }
  } else if (params.action === "activate") {
    const next = items.find(
      (item) => item.status === "active" && item.metadata?.campaignState === "waiting",
    );
    if (next) {
      await mergePlannerItemMetadata({
        userId: params.userId,
        itemId: next.id,
        metadata: { campaignState: "active", campaignActivatedAt: new Date().toISOString() },
      });
    }
  }
  for (const policy of policies) {
    await updateReminderPolicy({
      policyId: policy.id,
      userId: params.userId,
      status:
        params.action === "cancel"
          ? "cancelled"
          : params.action === "pause"
            ? "paused"
            : params.action === "resume"
              ? "active"
              : undefined,
      metadata:
        params.action === "activate" ? { campaignState: "active" } : { campaignControl: params.action },
    });
  }
  return { itemCount: items.length, policyCount: policies.length };
}
