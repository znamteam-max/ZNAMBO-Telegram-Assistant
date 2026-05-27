import OpenAI from "openai";

import { getEnv, requireEnv } from "@/lib/env";

let client: OpenAI | null = null;

export function getOpenAIClient() {
  if (!client) {
    client = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
  }
  return client;
}

export function canUseOpenAI() {
  return Boolean(getEnv().OPENAI_API_KEY);
}
