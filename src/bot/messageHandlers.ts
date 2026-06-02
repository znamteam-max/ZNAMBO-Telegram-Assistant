import type { Bot } from "grammy";

import { transcribeMedia } from "@/ai/transcription";
import { recordMessageAttachment, markTelegramMessageProcessed } from "@/db/queries/messages";
import { UserFacingError } from "@/lib/errors";
import {
  downloadTelegramMedia,
  extractTelegramMedia,
  TELEGRAM_DOWNLOAD_LIMIT_BYTES,
} from "@/integrations/telegramFiles";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { handleIncomingUserMessage } from "./messagePipeline";
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
      await handleIncomingUserMessage(ctx, transcript, owner.timezone);
    } catch (error) {
      await replyAndRecord(ctx, toUserMessage(error));
    }
  });
}

async function handleNaturalText(ctx: BotContext, text: string) {
  const owner = requireOwner(ctx);
  try {
    await handleIncomingUserMessage(ctx, text, owner.timezone);
    if (ctx.dbMessageId) await markTelegramMessageProcessed(ctx.dbMessageId);
  } catch (error) {
    await replyAndRecord(ctx, toUserMessage(error));
  }
}

function toUserMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof Error && /OPENAI_API_KEY/.test(error.message)) {
    return "Для этого действия нужен OPENAI_API_KEY в env.";
  }
  return "Не получилось обработать сообщение. Ошибку записал в лог без секретов.";
}
