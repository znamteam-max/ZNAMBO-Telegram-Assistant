import { eq } from "drizzle-orm";

import { getDb } from "../client";
import { messageAttachments, telegramMessages } from "../schema";
import { toTelegramBigInt } from "./users";

export type TelegramUpdateRecordInput = {
  updateId: number | bigint;
  userId?: string | null;
  telegramUserId?: number | string | bigint | null;
  chatId?: number | string | bigint | null;
  telegramMessageId?: number | string | bigint | null;
  messageType: string;
  text?: string | null;
  raw: Record<string, unknown>;
};

export async function recordTelegramUpdate(
  input: TelegramUpdateRecordInput,
): Promise<string | null> {
  const [row] = await getDb()
    .insert(telegramMessages)
    .values({
      updateId: toTelegramBigInt(input.updateId),
      userId: input.userId,
      telegramUserId: input.telegramUserId ? toTelegramBigInt(input.telegramUserId) : null,
      chatId: input.chatId ? toTelegramBigInt(input.chatId) : null,
      telegramMessageId: input.telegramMessageId ? toTelegramBigInt(input.telegramMessageId) : null,
      messageType: input.messageType,
      text: input.text,
      raw: input.raw,
    })
    .onConflictDoNothing({ target: telegramMessages.updateId })
    .returning({ id: telegramMessages.id });

  return row?.id ?? null;
}

export async function markTelegramMessageProcessed(messageId: string, transcript?: string | null) {
  await getDb()
    .update(telegramMessages)
    .set({ processedAt: new Date(), transcript })
    .where(eq(telegramMessages.id, messageId));
}

export async function recordMessageAttachment(params: {
  messageId: string;
  telegramFileId: string;
  telegramFileUniqueId?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  durationSeconds?: number | null;
  status?: string;
}) {
  await getDb()
    .insert(messageAttachments)
    .values({
      messageId: params.messageId,
      telegramFileId: params.telegramFileId,
      telegramFileUniqueId: params.telegramFileUniqueId,
      mimeType: params.mimeType,
      fileSize: params.fileSize,
      durationSeconds: params.durationSeconds,
      status: params.status ?? "processed",
    });
}
