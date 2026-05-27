import type { Bot } from "grammy";

import { buildMemoryContext } from "@/ai/memoryContext";
import { parseUserRequest } from "@/ai/parseUserRequest";
import { transcribeMedia } from "@/ai/transcription";
import { recordMessageAttachment, markTelegramMessageProcessed } from "@/db/queries/messages";
import { createPendingAction } from "@/db/queries/pendingActions";
import { createIdempotencyKey } from "@/lib/idempotency";
import { UserFacingError } from "@/lib/errors";
import {
  downloadTelegramMedia,
  extractTelegramMedia,
  TELEGRAM_DOWNLOAD_LIMIT_BYTES,
} from "@/integrations/telegramFiles";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { formatProposalCard } from "./formatters";
import { pendingActionKeyboard } from "./keyboards";

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

      await ctx.reply("Расшифровываю сообщение...");
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

      await ctx.reply(`Расшифровка: ${transcript}`);
      await processProposal(ctx, transcript, owner.timezone);
    } catch (error) {
      await ctx.reply(toUserMessage(error));
    }
  });
}

async function handleNaturalText(ctx: BotContext, text: string) {
  const owner = requireOwner(ctx);
  try {
    await processProposal(ctx, text, owner.timezone);
    if (ctx.dbMessageId) await markTelegramMessageProcessed(ctx.dbMessageId);
  } catch (error) {
    await ctx.reply(toUserMessage(error));
  }
}

async function processProposal(ctx: BotContext, text: string, timezone: string) {
  const owner = requireOwner(ctx);
  const proposal = await parseUserRequest({
    text,
    timezone,
    memoryContext: await buildMemoryContext(owner.id),
  });

  if (proposal.intent === "answer") {
    await ctx.reply(proposal.reply || "Для этого есть команды /today, /tomorrow, /week и /tasks.");
    return;
  }

  if (proposal.intent === "ambiguous") {
    const options = proposal.disambiguationOptions.length
      ? proposal.disambiguationOptions
          .map(
            (option, index) =>
              `${index + 1}. ${option.label}${option.details ? ` — ${option.details}` : ""}`,
          )
          .join("\n")
      : "Нужно уточнение.";
    await ctx.reply(`Не буду угадывать. Уточни вариант:\n${options}`);
    return;
  }

  if (proposal.intent !== "create_item") {
    await ctx.reply(
      "Для изменения или удаления сначала покажу варианты. В MVP это пока лучше делать через явную новую формулировку.",
    );
    return;
  }

  const pending = await createPendingAction({
    userId: owner.id,
    sourceMessageId: ctx.dbMessageId,
    actionType: "create_item",
    payload: proposal,
    idempotencyKey: createIdempotencyKey([owner.id, ctx.update.update_id, text]),
  });

  await ctx.reply(formatProposalCard(proposal, timezone), {
    reply_markup: pendingActionKeyboard(pending.id),
  });
}

function toUserMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof Error && /OPENAI_API_KEY/.test(error.message)) {
    return "Для этого действия нужен OPENAI_API_KEY в env.";
  }
  return "Не получилось обработать сообщение. Ошибку записал в лог без секретов.";
}
