import { NextResponse } from "next/server";

import {
  getCalendarProvider,
  getEnv,
  isGoogleCalendarConfigured,
  isYandexCalendarConfigured,
} from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const env = getEnv();
  return NextResponse.json({
    ok: true,
    deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    defaultTimezone: env.DEFAULT_TIMEZONE,
    pipelineMode: env.JARVIS_MODE_ENABLED ? "jarvis" : "legacy_v2",
    jarvisModeEnabled: env.JARVIS_MODE_ENABLED,
    calendarProvider: getCalendarProvider(),
    googleCalendarConfigured: isGoogleCalendarConfigured(),
    yandexCalendarConfigured: isYandexCalendarConfigured(),
  });
}
