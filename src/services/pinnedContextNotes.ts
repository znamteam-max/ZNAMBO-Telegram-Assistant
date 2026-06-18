import { writeAudit } from "@/db/queries/audit";
import {
  cancelPlannerItemWithMetadata,
  createManualPlannerItem,
  findPinnedContextNotes,
  listPinnedContextNotes,
  updatePlannerItemDetails,
} from "@/db/queries/items";
import {
  formatPinnedContextNoteLine,
  type PinnedContextIntent,
} from "@/domain/pinnedContextNotes";

export async function createPinnedContextNote(params: {
  userId: string;
  timezone: string;
  sourceMessageId?: string | null;
  intent: Extract<PinnedContextIntent, { type: "create" }>;
}) {
  const existing =
    params.intent.category === "car_location"
      ? (await listPinnedContextNotes(params.userId, 50)).find(
          (item) => item.metadata?.pinnedCategory === "car_location",
        )
      : null;
  if (existing) {
    const item = await updatePlannerItemDetails({
      userId: params.userId,
      itemId: existing.id,
      kind: "note",
      title: params.intent.title,
      description: params.intent.body,
      startAt: null,
      endAt: null,
      dueAt: null,
      category: "pinned_context",
      visibility: "active",
      sourcePolicyId: null,
      metadata: {
        pinnedContext: true,
        pinnedCategory: params.intent.category,
        codeword: params.intent.codeword,
        textHash: params.intent.textHash,
        sourceTimezone: params.timezone,
        mutableByReminderFlow: false,
        excludeFromRecurringPolicyResolution: true,
        pinnedContextUpdatedAt: new Date().toISOString(),
      },
    });
    if (!item) throw new Error("Pinned context note update failed");
    await writeAudit({
      userId: params.userId,
      action: "assistant.pinned_context_note_updated",
      entityType: "planner_item",
      entityId: item.id,
      details: {
        sourceMessageId: params.sourceMessageId ?? null,
        category: params.intent.category,
        codeword: params.intent.codeword,
        textHash: params.intent.textHash,
      },
    }).catch(() => undefined);
    return item;
  }
  const item = await createManualPlannerItem({
    userId: params.userId,
    kind: "note",
    title: params.intent.title,
    timezone: params.timezone,
    description: params.intent.body,
    category: "pinned_context",
    metadata: {
      pinnedContext: true,
      pinnedCategory: params.intent.category,
      codeword: params.intent.codeword,
      textHash: params.intent.textHash,
      sourceTimezone: params.timezone,
      mutableByReminderFlow: false,
      excludeFromRecurringPolicyResolution: true,
    },
  });
  await writeAudit({
    userId: params.userId,
    action: "assistant.pinned_context_note_created",
    entityType: "planner_item",
    entityId: item.id,
    details: {
      sourceMessageId: params.sourceMessageId ?? null,
      category: params.intent.category,
      codeword: params.intent.codeword,
      textHash: params.intent.textHash,
    },
  }).catch(() => undefined);
  return item;
}

export async function answerPinnedContextQuery(params: {
  userId: string;
  intent: Extract<PinnedContextIntent, { type: "query" | "list" }>;
}) {
  const notes =
    params.intent.type === "list"
      ? await listPinnedContextNotes(params.userId, 20)
      : await findPinnedContextNotes({
          userId: params.userId,
          query: params.intent.query,
          limit: 5,
        }).then((items) =>
          params.intent.category === "car_location"
            ? items.filter((item) => item.metadata?.pinnedCategory === "car_location")
            : items,
        );
  await writeAudit({
    userId: params.userId,
    action: "assistant.pinned_context_note_answered",
    entityType: "planner_item",
    entityId: notes[0]?.id ?? undefined,
    details: {
      queryCategory: params.intent.type === "list" ? "all" : params.intent.category,
      resultCount: notes.length,
    },
  }).catch(() => undefined);
  if (!notes.length) {
    return params.intent.type === "list"
      ? "Закреплённых заметок пока нет."
      : "Не нашёл закреплённую заметку по этому запросу.";
  }
  if (notes.length === 1) return formatPinnedContextAnswerLine(notes[0]);
  return ["Закреплено:", ...notes.map((note) => `• ${formatPinnedContextNoteLine(note)}`)].join(
    "\n",
  );
}

export async function deletePinnedContextNote(params: {
  userId: string;
  intent: Extract<PinnedContextIntent, { type: "delete" }>;
  now?: Date;
}) {
  const candidates = await findPinnedContextNotes({
    userId: params.userId,
    query: params.intent.query,
    limit: 5,
  });
  const item =
    params.intent.category === "car_location"
      ? candidates.find((candidate) => candidate.metadata?.pinnedCategory === "car_location")
      : candidates[0];
  if (!item) return { deleted: null, reply: "Не нашёл такую закреплённую заметку." };
  const deleted = await cancelPlannerItemWithMetadata({
    userId: params.userId,
    itemId: item.id,
    metadata: {
      pinnedContextDeletedAt: (params.now ?? new Date()).toISOString(),
      deletedBy: "pinned_context_note_flow",
    },
  });
  await writeAudit({
    userId: params.userId,
    action: "assistant.pinned_context_note_deleted",
    entityType: "planner_item",
    entityId: item.id,
    details: { category: item.metadata?.pinnedCategory ?? null },
  }).catch(() => undefined);
  return {
    deleted,
    reply: deleted
      ? `Убрал из закреплённых: ${formatPinnedContextNoteLine(item)}`
      : "Не смог убрать заметку. Ничего лишнего не удалял.",
  };
}

export function formatPinnedContextCreationReply(item: {
  title: string;
  description: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  return ["Закрепил отдельную заметку:", formatPinnedContextNoteLine(item)].join("\n");
}

function formatPinnedContextAnswerLine(item: {
  title: string;
  description: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const line = formatPinnedContextNoteLine(item);
  return line.replace(" — ", ": ");
}
