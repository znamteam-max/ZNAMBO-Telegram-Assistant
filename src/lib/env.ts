import { DateTime } from "luxon";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  DEFAULT_TIMEZONE: z.string().default("Europe/Helsinki"),
  APP_ENCRYPTION_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  ALLOWED_TELEGRAM_USER_IDS: z.string().default(""),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_TEXT_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  CRON_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().default("http://localhost:3000/api/google/oauth/callback"),
  GOOGLE_CALENDAR_ID: z.string().default("primary"),
  GOOGLE_TOKEN_ENCRYPTION_KEY: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
    if (!DateTime.local().setZone(cachedEnv.DEFAULT_TIMEZONE).isValid) {
      throw new Error(`Invalid DEFAULT_TIMEZONE: ${cachedEnv.DEFAULT_TIMEZONE}`);
    }
  }
  return cachedEnv;
}

export function resetEnvCacheForTests() {
  cachedEnv = null;
}

export function requireEnv<K extends keyof AppEnv>(key: K): NonNullable<AppEnv[K]> {
  const value = getEnv()[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${String(key)}`);
  }
  return value as NonNullable<AppEnv[K]>;
}

export function getAllowedTelegramUserIds(): Set<string> {
  return new Set(
    getEnv()
      .ALLOWED_TELEGRAM_USER_IDS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isGoogleCalendarConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);
}
