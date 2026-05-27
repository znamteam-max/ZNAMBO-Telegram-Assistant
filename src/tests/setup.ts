import { beforeEach } from "vitest";

import { resetEnvCacheForTests } from "@/lib/env";

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.DEFAULT_TIMEZONE = "Europe/Helsinki";
  process.env.APP_ENCRYPTION_KEY = "test-encryption-secret";
  process.env.ALLOWED_TELEGRAM_USER_IDS = "42";
  process.env.OPENAI_TEXT_MODEL = "gpt-4o-mini";
  process.env.OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
  resetEnvCacheForTests();
});
