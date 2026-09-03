import { toFile } from "openai";

import { getEnv } from "@/lib/env";

import { getOpenAIClient } from "./openaiClient";

export const OPENAI_TRANSCRIPTION_LIMIT_BYTES = 25 * 1024 * 1024;

export type TranscriptionWithUsage = {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationSeconds: number | null;
};

export async function transcribeMedia(params: {
  bytes: Buffer;
  filename: string;
  mimeType?: string | null;
}): Promise<string> {
  return (await transcribeMediaWithUsage(params)).text;
}

export async function transcribeMediaWithUsage(params: {
  bytes: Buffer;
  filename: string;
  mimeType?: string | null;
}): Promise<TranscriptionWithUsage> {
  if (params.bytes.byteLength > OPENAI_TRANSCRIPTION_LIMIT_BYTES) {
    throw new Error("Файл больше 25 МБ и не может быть отправлен в транскрипцию OpenAI.");
  }

  const file = await toFile(params.bytes, params.filename, {
    type: params.mimeType ?? "application/octet-stream",
  });
  const model = getEnv().OPENAI_TRANSCRIPTION_MODEL;
  const result = await getOpenAIClient().audio.transcriptions.create({
    file,
    model,
    response_format: "json",
  });
  const objectResult = typeof result === "string" ? null : (result as unknown as Record<string, unknown>);
  const usage = objectResult?.usage as Record<string, unknown> | undefined;

  return {
    text: typeof result === "string" ? result : result.text,
    model,
    inputTokens: numberOrNull(usage?.input_tokens ?? usage?.prompt_tokens),
    outputTokens: numberOrNull(usage?.output_tokens ?? usage?.completion_tokens),
    totalTokens: numberOrNull(usage?.total_tokens),
    durationSeconds: numberOrNull(usage?.seconds ?? usage?.duration_seconds),
  };
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}
