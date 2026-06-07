import { and, eq, gt } from "drizzle-orm";

import { plannerActionProposalSchema, type PlannerActionProposal } from "@/ai/schemas";
import { isHardManagementText, SAFE_MANAGEMENT_FALLBACK_REPLY } from "@/agent/hardManagementIntent";
import { materializeProposal } from "@/domain/itemService";
import type { MaterializedReminder } from "@/domain/types";
import { UserFacingError } from "@/lib/errors";

import { getDb } from "../client";
import {
  auditLog,
  memories,
  pendingActions,
  plannerItems,
  reminders,
  users,
  type PlannerItem,
} from "../schema";
import { toTelegramBigInt } from "./users";

export type ConfirmPendingActionResult =
  | {
      status: "created";
      item: PlannerItem;
      reminders: MaterializedReminder[];
      proposal: PlannerActionProposal;
    }
  | { status: "already_confirmed"; item: PlannerItem }
  | { status: "expired" | "not_found" | "cancelled" };

export async function createPendingAction(params: {
  userId: string;
  sourceMessageId?: string | null;
  actionType: string;
  payload: PlannerActionProposal;
  idempotencyKey: string;
  ttlMinutes?: number;
}) {
  assertProposalIsNotManagementCommand(params.payload);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.ttlMinutes ?? 60) * 60 * 1000);
  const [inserted] = await getDb()
    .insert(pendingActions)
    .values({
      userId: params.userId,
      sourceMessageId: params.sourceMessageId,
      actionType: params.actionType,
      payload: params.payload,
      idempotencyKey: params.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing({ target: pendingActions.idempotencyKey })
    .returning();

  if (inserted) return inserted;

  const [existing] = await getDb()
    .select()
    .from(pendingActions)
    .where(eq(pendingActions.idempotencyKey, params.idempotencyKey))
    .limit(1);
  return existing;
}

export async function cancelPendingAction(userId: string, pendingActionId: string) {
  const [cancelled] = await getDb()
    .update(pendingActions)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(pendingActions.userId, userId),
        eq(pendingActions.id, pendingActionId),
        eq(pendingActions.status, "pending"),
      ),
    )
    .returning();
  return cancelled ?? null;
}

export async function confirmPendingActionInDb(params: {
  pendingActionId: string;
  telegramUserId: number | string | bigint;
  now?: Date;
}): Promise<ConfirmPendingActionResult> {
  const now = params.now ?? new Date();
  const telegramUserId = toTelegramBigInt(params.telegramUserId);

  return getDb().transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId))
      .limit(1);

    if (!user) return { status: "not_found" as const };

    const [action] = await tx
      .update(pendingActions)
      .set({ status: "confirmed", confirmedAt: now, updatedAt: now })
      .where(
        and(
          eq(pendingActions.id, params.pendingActionId),
          eq(pendingActions.userId, user.id),
          eq(pendingActions.status, "pending"),
          gt(pendingActions.expiresAt, now),
        ),
      )
      .returning();

    if (!action) {
      const [existingItem] = await tx
        .select()
        .from(plannerItems)
        .where(eq(plannerItems.pendingActionId, params.pendingActionId))
        .limit(1);
      if (existingItem) return { status: "already_confirmed" as const, item: existingItem };

      const [existingAction] = await tx
        .select()
        .from(pendingActions)
        .where(
          and(eq(pendingActions.id, params.pendingActionId), eq(pendingActions.userId, user.id)),
        )
        .limit(1);
      if (!existingAction) return { status: "not_found" as const };
      if (existingAction.status === "cancelled") return { status: "cancelled" as const };
      return { status: "expired" as const };
    }

    const proposal = plannerActionProposalSchema.parse(action.payload);
    assertProposalIsNotManagementCommand(proposal);
    const materialized = materializeProposal({
      proposal,
      userTimezone: user.timezone,
      now,
    });

    const [item] = await tx
      .insert(plannerItems)
      .values({
        userId: user.id,
        pendingActionId: action.id,
        kind: materialized.item.kind,
        title: materialized.item.title,
        description: materialized.item.description,
        location: materialized.item.location,
        timezone: materialized.item.timezone,
        startAt: materialized.item.startAt,
        endAt: materialized.item.endAt,
        dueAt: materialized.item.dueAt,
        priority: materialized.item.priority,
        metadata: materialized.item.metadata,
      })
      .onConflictDoNothing({ target: plannerItems.pendingActionId })
      .returning();

    if (!item) {
      throw new UserFacingError("Эта запись уже была создана.");
    }

    if (materialized.reminders.length) {
      await tx
        .insert(reminders)
        .values(
          materialized.reminders.map((reminder) => ({
            userId: user.id,
            plannerItemId: item.id,
            type: reminder.type,
            idempotencyKey: `${item.id}:${reminder.type}:${reminder.scheduledAt.toISOString()}`,
            scheduledAt: reminder.scheduledAt,
            payload: reminder.payload,
          })),
        )
        .onConflictDoNothing();
    }

    if (proposal.memoryCandidates.length) {
      await tx.insert(memories).values(
        proposal.memoryCandidates.map((memory) => ({
          userId: user.id,
          category: memory.category,
          content: memory.content,
          status: "pending_confirmation",
          sourceMessageId: action.sourceMessageId,
          searchTags: memory.searchTags,
        })),
      );
    }

    await tx.insert(auditLog).values({
      userId: user.id,
      action: "item.created",
      entityType: "planner_item",
      entityId: item.id,
      details: { kind: item.kind, pendingActionId: action.id },
    });

    return {
      status: "created" as const,
      item,
      reminders: materialized.reminders,
      proposal,
    };
  });
}

function assertProposalIsNotManagementCommand(proposal: PlannerActionProposal) {
  const candidates = [
    proposal.title ?? "",
    proposal.description ?? "",
  ];
  if (candidates.some((value) => isHardManagementText(value))) {
    throw new UserFacingError(SAFE_MANAGEMENT_FALLBACK_REPLY);
  }
}
