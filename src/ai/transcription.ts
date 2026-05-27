import { toFile } from "openai";

import { getEnv } from "@/lib/env";

import { getOpenAIClient } from "./openaiClient";

export const OPENAI_TRANSCRIPTION_LIMIT_BYTES = 25 * 1024 * 1024;

export async function transcribeMedia(params: {
  bytes: Buffer;
  filename: string;
  mimeType?: string | null;
}): Promise<string> {
  if (params.bytes.byteLength > OPENAI_TRANSCRIPTION_LIMIT_BYTES) {
    throw new Error("Файл больше 25 МБ и не может быть отправлен в транскрипцию OpenAI.");
  }

  const file = await toFile(params.bytes, params.filename, {
    type: params.mimeType ?? "application/octet-stream",
  });
  const result = await getOpenAIClient().audio.transcriptions.create({
    file,
    model: getEnv().OPENAI_TRANSCRIPTION_MODEL,
    response_format: "json",
  });

  return typeof result === "string" ? result : result.text;
}
