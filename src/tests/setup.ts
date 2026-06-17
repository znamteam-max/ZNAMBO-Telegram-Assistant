import { beforeEach } from "vitest";

import { resetEnvCacheForTests } from "@/lib/env";

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.DEFAULT_TIMEZONE = "Europe/Moscow";
  process.env.OWNER_TIMEZONE = "Europe/Moscow";
  process.env.APP_ENCRYPTION_KEY = "test-encryption-secret";
  process.env.ALLOWED_TELEGRAM_USER_IDS = "42";
  process.env.OPENAI_TEXT_MODEL = "gpt-4o-mini";
  process.env.OPENAI_PLANNER_MODEL = "gpt-4o-mini";
  process.env.OPENAI_MEMORY_MODEL = "gpt-4o-mini";
  process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  process.env.OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
  process.env.OPENAI_REQUIRED_FOR_NATURAL_LANGUAGE = "true";
  process.env.ENABLE_AGENT_PLANNER_V2 = "true";
  process.env.ENABLE_MEMORY_EMBEDDINGS = "false";
  process.env.SMART_COMMIT_MODE = "auto_low_risk";
  process.env.DEFAULT_MORNING_REMINDER_TIME = "09:30";
  delete process.env.CALENDAR_PROVIDER;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.YANDEX_CALDAV_USERNAME;
  delete process.env.YANDEX_CALDAV_APP_PASSWORD;
  resetEnvCacheForTests();
});
