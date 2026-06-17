import { randomUUID } from "node:crypto";

import { recordAgentAction } from "@/db/queries/agentActions";
import {
  cancelPlannerItemWithMetadata,
  createManualPlannerItem,
  getPlannerItemById,
} from "@/db/queries/items";
import { writeAudit } from "@/db/queries/audit";
import { parseStandaloneIntervalWindowReminderIntent } from "@/domain/intervalWindowReminderIntent";
import { clearActiveInteractionSessionsWithDetails } from "@/bot/sessionRouting";
import {
  createIntervalWindowReminderFromIntent,
  formatIntervalWindowCreationReply,
} from "@/services/intervalWindowReminderCreation";

const SMOKE_TEXT = "Завтра с 6 до 7.30 напоминай мне каждые 10 минут взять с собой спицы";

export async function runV2220IntervalWindowSmoke(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const smokeRunId = randomUUID();
  const intent = parseStandaloneIntervalWindowReminderIntent({
    text: SMOKE_TEXT,
    timezone: params.timezone,
    now,
  });
  if (!intent) {
    return {
      ok: false,
      error: "interval_window_intent_parse_failed",
      smokeRunId,
      textHash: null,
    };
  }

  const oldTarget = await createManualPlannerItem({
    userId: params.userId,
    kind: "recurring_task",
    title: "V2.22 smoke old recurring session target",
    timezone: params.timezone,
    category: "recurring",
    visibility: "active",
    metadata: { isTest: true, source: "v2220_interval_window_smoke", smokeRunId },
  });
  const oldTargetBefore = {
    id: oldTarget.id,
    title: oldTarget.title,
    kind: oldTarget.kind,
    status: oldTarget.status,
  };
  const expiresAt = new Date(now.getTime() + 30 * 60_000);
  const session = await recordAgentAction({
    userId: params.userId,
    actionType: "reminder_policy_edit_session",
    status: "pending",
    input: { itemId: oldTarget.id, section: "custom", smokeRunId },
    output: {
      itemId: oldTarget.id,
      section: "custom",
      expiresAt: expiresAt.toISOString(),
      draft: { intervalMinutes: 60 },
      smokeRunId,
    },
  });

  const cleared = await clearActiveInteractionSessionsWithDetails({
    userId: params.userId,
    reason: "v2220_interval_window_smoke_escape",
  });
  for (const clearedSession of cleared) {
    await writeAudit({
      userId: params.userId,
      action: "assistant.session_escape_to_new_intent",
      entityType: "agent_action",
      entityId: session?.id ?? null,
      details: {
        escapedSessionType: clearedSession.type,
        escapedItemId: clearedSession.itemId,
        escapedActionId: clearedSession.actionId,
        newIntent: intent.intent,
        reason: intent.reason,
        textHash: intent.textHash,
        timezone: params.timezone,
        smokeRunId,
      },
    }).catch(() => undefined);
  }

  const oldTargetAfterEscape = await getPlannerItemById(params.userId, oldTarget.id);
  const oldTargetUnchanged =
    oldTargetAfterEscape?.id === oldTargetBefore.id &&
    oldTargetAfterEscape.title === oldTargetBefore.title &&
    oldTargetAfterEscape.kind === oldTargetBefore.kind &&
    oldTargetAfterEscape.status === oldTargetBefore.status;

  const created = await createIntervalWindowReminderFromIntent({
    userId: params.userId,
    sourceMessageId: smokeRunId,
    intent,
    now,
  });

  const archivedOldTarget = await cancelPlannerItemWithMetadata({
    userId: params.userId,
    itemId: oldTarget.id,
    metadata: {
      archivedBy: "v2220_interval_window_smoke",
      archiveReason: "temporary_old_session_target_cleanup",
      smokeRunId,
    },
  });

  const result = {
    ok:
      oldTargetUnchanged &&
      cleared.some((entry) => entry.actionId === session?.id) &&
      created.item.id !== oldTarget.id &&
      created.policy.itemId === created.item.id,
    smokeRunId,
    textHash: intent.textHash,
    oldTargetItemId: oldTarget.id,
    oldTargetArchived: archivedOldTarget?.status === "cancelled",
    oldTargetUnchangedBeforeCleanup: oldTargetUnchanged,
    createdItemId: created.item.id,
    createdPolicyId: created.policy.id,
    createdReminderId: created.reminder?.id ?? null,
    createdTitle: created.item.title,
    windowStartLocal: intent.windowStartLocal,
    windowEndLocal: intent.windowEndLocal,
    startsAt: created.item.startAt?.toISOString() ?? null,
    dueAt: created.item.dueAt?.toISOString() ?? null,
    policyStartsAt: created.policy.startsAt?.toISOString() ?? null,
    policyEndsAt: created.policy.endsAt?.toISOString() ?? null,
    policyIntervalMinutes: created.policy.intervalMinutes,
    escapedSessionCount: cleared.length,
    escapedSessionTypes: cleared.map((entry) => entry.type),
    replyPreview: formatIntervalWindowCreationReply({ result: created, intent }),
  };

  await writeAudit({
    userId: params.userId,
    action: "assistant.v2220_interval_window_smoke",
    entityType: "planner_item",
    entityId: created.item.id,
    details: result,
  }).catch(() => undefined);

  return result;
}
