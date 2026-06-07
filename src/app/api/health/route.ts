import { NextResponse } from "next/server";

import {
  getCalendarProvider,
  getEnv,
  isGoogleCalendarConfigured,
  isYandexCalendarConfigured,
} from "@/lib/env";
import { getLatestAiAuditStatus } from "@/db/queries/audit";
import { APP_VERSION } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const env = getEnv();
  const [lastSuccessfulAi, lastAiCall] = await Promise.all([
    getLatestAiAuditStatus({ succeeded: true }).catch(() => null),
    getLatestAiAuditStatus().catch(() => null),
  ]);
  const lastSuccessfulDetails = lastSuccessfulAi?.details as Record<string, unknown> | undefined;
  const lastCallDetails = lastAiCall?.details as Record<string, unknown> | undefined;
  return NextResponse.json({
    ok: true,
    appVersion: APP_VERSION,
    deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    defaultTimezone: env.DEFAULT_TIMEZONE,
    pipelineMode: env.JARVIS_MODE_ENABLED ? "jarvis" : "legacy_v2",
    jarvisModeEnabled: env.JARVIS_MODE_ENABLED,
    openAiConfigured: Boolean(env.OPENAI_API_KEY),
    openAiRequiredForNaturalLanguage: env.OPENAI_REQUIRED_FOR_NATURAL_LANGUAGE,
    lastSuccessfulAiCallAt: lastSuccessfulAi?.createdAt?.toISOString() ?? null,
    lastAiModel: String(lastSuccessfulDetails?.aiModel ?? lastCallDetails?.aiModel ?? "") || null,
    lastAiErrorType:
      lastCallDetails?.aiSucceeded === true ? null : String(lastCallDetails?.errorCode ?? "") || null,
    calendarProvider: getCalendarProvider(),
    googleCalendarConfigured: isGoogleCalendarConfigured(),
    yandexCalendarConfigured: isYandexCalendarConfigured(),
  });
}
