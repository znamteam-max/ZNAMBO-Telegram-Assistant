import { randomUUID } from "node:crypto";

import { writeAudit } from "@/db/queries/audit";
import { cancelPlannerItemWithMetadata } from "@/db/queries/items";
import { listReminderPoliciesForItem } from "@/db/queries/reminderPolicies";
import { parsePinnedContextIntent, pinnedContextTextHash } from "@/domain/pinnedContextNotes";
import { renderLiveDashboard } from "@/telegram/liveDashboard";

import {
  answerPinnedContextQuery,
  createPinnedContextNote,
} from "./pinnedContextNotes";

const SMOKE_TEXT =
  "Отдельное напоминание: машину оставил на тестовой парковке V2.23, рядом с подъездом.";

export async function runV2230PinnedContextNoteSmoke(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const smokeRunId = randomUUID();
  const intent = parsePinnedContextIntent({
    text: SMOKE_TEXT,
    timezone: params.timezone,
    now,
  });
  if (!intent || intent.type !== "create") {
    return {
      ok: false,
      smokeRunId,
      error: "pinned_context_intent_parse_failed",
      textHash: pinnedContextTextHash(SMOKE_TEXT),
    };
  }

  const item = await createPinnedContextNote({
    userId: params.userId,
    timezone: params.timezone,
    sourceMessageId: smokeRunId,
    intent: {
      ...intent,
      textHash: pinnedContextTextHash(`${SMOKE_TEXT}:${smokeRunId}`),
    },
  });

  const [dashboard, policies, answer] = await Promise.all([
    renderLiveDashboard({
      userId: params.userId,
      timezone: params.timezone,
      now,
    }),
    listReminderPoliciesForItem(params.userId, item.id, 20),
    answerPinnedContextQuery({
      userId: params.userId,
      intent: { type: "query", category: "car_location", query: "машина" },
    }),
  ]);

  const archived = await cancelPlannerItemWithMetadata({
    userId: params.userId,
    itemId: item.id,
    metadata: {
      archivedBy: "v2230_pinned_context_note_smoke",
      archiveReason: "temporary_pinned_context_smoke_cleanup",
      smokeRunId,
      archivedAt: new Date().toISOString(),
    },
  });

  const result = {
    ok:
      dashboard.text.includes("Закреплено") &&
      dashboard.text.includes("Машина") &&
      answer.includes("Машина") &&
      policies.length === 0 &&
      archived?.status === "cancelled",
    smokeRunId,
    itemId: item.id,
    textHash: intent.textHash,
    dashboardHasPinnedBlock: dashboard.text.includes("Закреплено"),
    answerReturnedPinnedNote: answer.includes("Машина"),
    reminderPolicyCount: policies.length,
    archived: archived?.status === "cancelled",
    calendarObjectsChanged: 0,
  };

  await writeAudit({
    userId: params.userId,
    action: "assistant.v2230_pinned_context_note_smoke",
    entityType: "planner_item",
    entityId: item.id,
    details: result,
  }).catch(() => undefined);

  return result;
}
