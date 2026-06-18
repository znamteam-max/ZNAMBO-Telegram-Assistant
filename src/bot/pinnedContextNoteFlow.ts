import { writeAudit } from "@/db/queries/audit";
import { parsePinnedContextIntent } from "@/domain/pinnedContextNotes";
import {
  answerPinnedContextQuery,
  createPinnedContextNote,
  deletePinnedContextNote,
  formatPinnedContextCreationReply,
} from "@/services/pinnedContextNotes";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { pinnedContextNoteKeyboard } from "./keyboards";
import { replyAndRecord } from "./reply";

export async function handlePinnedContextNoteTurn(
  ctx: BotContext,
  text: string,
  timezone: string,
  now = new Date(),
) {
  const intent = parsePinnedContextIntent({ text, timezone, now });
  if (!intent) return false;
  const owner = requireOwner(ctx);

  if (intent.type === "create") {
    const item = await createPinnedContextNote({
      userId: owner.id,
      timezone,
      sourceMessageId: ctx.dbMessageId,
      intent,
    });
    await replyAndRecord(ctx, formatPinnedContextCreationReply(item), {
      reply_markup: pinnedContextNoteKeyboard(item.id),
    });
    await refreshPinnedDashboardBestEffort(ctx, timezone);
    return true;
  }

  if (intent.type === "delete") {
    const result = await deletePinnedContextNote({ userId: owner.id, intent, now });
    await replyAndRecord(ctx, result.reply);
    await refreshPinnedDashboardBestEffort(ctx, timezone);
    return true;
  }

  const reply = await answerPinnedContextQuery({ userId: owner.id, intent });
  await replyAndRecord(ctx, reply);
  await writeAudit({
    userId: owner.id,
    action: "assistant.pinned_context_note_opened",
    entityType: "telegram_message",
    entityId: ctx.dbMessageId,
    details: { intentType: intent.type },
  }).catch(() => undefined);
  return true;
}

async function refreshPinnedDashboardBestEffort(ctx: BotContext, timezone: string) {
  const owner = ctx.owner;
  if (!owner || !ctx.chat?.id) return;
  await refreshDashboardAfterMutation({
    userId: owner.id,
    chatId: ctx.chat.id,
    timezone,
  }).catch(() => undefined);
}
