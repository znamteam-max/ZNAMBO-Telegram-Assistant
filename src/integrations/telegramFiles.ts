import type { Bot } from "grammy";

import type { BotContext } from "@/bot/context";
import { requireEnv } from "@/lib/env";
import { UserFacingError } from "@/lib/errors";

export const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export type TelegramMedia = {
  fileId: string;
  fileUniqueId?: string;
  fileSize?: number;
  mimeType?: string;
  durationSeconds?: number;
  filename: string;
};

export function extractTelegramMedia(ctx: BotContext): TelegramMedia | null {
  const message = ctx.message;
  if (!message) return null;

  if ("voice" in message && message.voice) {
    return {
      fileId: message.voice.file_id,
      fileUniqueId: message.voice.file_unique_id,
      fileSize: message.voice.file_size,
      mimeType: message.voice.mime_type,
      durationSeconds: message.voice.duration,
      filename: "voice.ogg",
    };
  }
  if ("audio" in message && message.audio) {
    return {
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id,
      fileSize: message.audio.file_size,
      mimeType: message.audio.mime_type,
      durationSeconds: message.audio.duration,
      filename: message.audio.file_name ?? "audio.mp3",
    };
  }
  if ("video_note" in message && message.video_note) {
    return {
      fileId: message.video_note.file_id,
      fileUniqueId: message.video_note.file_unique_id,
      fileSize: message.video_note.file_size,
      durationSeconds: message.video_note.duration,
      filename: "video-note.mp4",
    };
  }
  if ("video" in message && message.video) {
    return {
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id,
      fileSize: message.video.file_size,
      mimeType: message.video.mime_type,
      durationSeconds: message.video.duration,
      filename: message.video.file_name ?? "video.mp4",
    };
  }
  return null;
}

export async function downloadTelegramMedia(bot: Bot<BotContext>, media: TelegramMedia) {
  if (media.fileSize && media.fileSize > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
    throw new UserFacingError(
      "Файл больше 20 МБ. Обычный Telegram Bot API не отдаёт такие файлы боту.",
    );
  }

  const file = await bot.api.getFile(media.fileId);
  if (file.file_size && file.file_size > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
    throw new UserFacingError(
      "Файл больше 20 МБ. Обычный Telegram Bot API не отдаёт такие файлы боту.",
    );
  }
  if (!file.file_path) {
    throw new UserFacingError("Telegram не вернул путь к файлу.");
  }

  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
