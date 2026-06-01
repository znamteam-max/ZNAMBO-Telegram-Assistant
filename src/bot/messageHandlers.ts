import type { Bot } from "grammy";

import { buildActionPlan } from "@/ai/planner";
import { transcribeMedia } from "@/ai/transcription";
import { recordMessageAttachment, markTelegramMessageProcessed } from "@/db/queries/messages";
import { UserFacingError } from "@/lib/errors";
import { createIdempotencyKey } from "@/lib/idempotency";
import {
  downloadTelegramMedia,
  extractTelegramMedia,
  TELEGRAM_DOWNLOAD_LIMIT_BYTES,
} from "@/integrations/telegramFiles";
import {
  commitStoredActionPlan,
  createStoredActionPlan,
  shouldAutoCommitPlan,
} from "@/services/actionPlanCommit";
import { syncItemsToCalendarBestEffort } from "@/services/calendarBestEffort";
import { buildActiveContext } from "@/services/contextRetrieval";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { formatActionPlanCard, formatCommittedPlanSummary } from "./formatters";
import { actionPlanKeyboard } from "./keyboards";
import { replyAndRecord } from "./reply";

export function registerMessageHandlers(bot: Bot<BotContext>) {
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    await handleNaturalText(ctx, ctx.message.text);
  });

  bot.on(["message:voice", "message:audio", "message:video_note", "message:video"], async (ctx) => {
    const media = extractTelegramMedia(ctx);
    if (!media) return;
    const owner = requireOwner(ctx);

    try {
      if (media.fileSize && media.fileSize > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
        throw new UserFacingError(
          "Файл больше 20 МБ. Для MVP поддерживаю только стандартный Bot API лимит.",
        );
      }

      await replyAndRecord(ctx, "Расшифровываю сообщение...");
      const bytes = await downloadTelegramMedia(bot, media);
      const transcript = await transcribeMedia({
        bytes,
        filename: media.filename,
        mimeType: media.mimeType,
      });

      if (ctx.dbMessageId) {
        await recordMessageAttachment({
          messageId: ctx.dbMessageId,
          telegramFileId: media.fileId,
          telegramFileUniqueId: media.fileUniqueId,
          mimeType: media.mimeType,
          fileSize: media.fileSize,
          durationSeconds: media.durationSeconds,
        });
        await markTelegramMessageProcessed(ctx.dbMessageId, transcript);
      }

      await replyAndRecord(ctx, `Расшифровка: ${transcript}`);
      await processActionPlan(ctx, transcript, owner.timezone);
    } catch (error) {
      await replyAndRecord(ctx, toUserMessage(error));
    }
  });
}

async function handleNaturalText(ctx: BotContext, text: string) {
  const owner = requireOwner(ctx);
  try {
    await processActionPlan(ctx, text, owner.timezone);
    if (ctx.dbMessageId) await markTelegramMessageProcessed(ctx.dbMessageId);
  } catch (error) {
    await replyAndRecord(ctx, toUserMessage(error));
  }
}

async function processActionPlan(ctx: BotContext, text: string, timezone: string) {
  const owner = requireOwner(ctx);
  const activeContext = await buildActiveContext({
    userId: owner.id,
    timezone,
    query: text,
  });
  const plan = await buildActionPlan({ text, timezone, activeContext });

  if (plan.intent === "answer" || plan.intent === "clarify") {
    await replyAndRecord(ctx, formatActionPlanCard(plan, timezone));
    return;
  }

  const storedPlan = await createStoredActionPlan({
    userId: owner.id,
    sourceMessageId: ctx.dbMessageId,
    plan,
    idempotencyKey: createIdempotencyKey([owner.id, ctx.update.update_id, text, "v2"]),
    commitMode: owner.smartCommitMode,
  });

  if (shouldAutoCommitPlan(plan, owner.smartCommitMode)) {
    const result = await commitStoredActionPlan({
      actionPlanId: storedPlan.id,
      userId: owner.id,
      timezone,
    });
    if (result.status === "committed") {
      await replyAndRecord(
        ctx,
        formatCommittedPlanSummary({
          items: result.items,
          reminderCount: result.reminders.length,
          timezone,
        }),
      );
      await syncItemsToCalendarBestEffort(result.items);
      return;
    }
    if (result.status === "already_committed") {
      await replyAndRecord(ctx, "Этот план уже был сохранён.");
      return;
    }
  }

  await replyAndRecord(ctx, formatActionPlanCard(plan, timezone), {
    reply_markup: actionPlanKeyboard(storedPlan.id),
  });
}

function toUserMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof Error && /OPENAI_API_KEY/.test(error.message)) {
    return "Для этого действия нужен OPENAI_API_KEY в env.";
  }
  return "Не получилось обработать сообщение. Ошибку записал в лог без секретов.";
}
