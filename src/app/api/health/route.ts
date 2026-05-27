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
    appUrl: env.NEXT_PUBLIC_APP_URL,
    defaultTimezone: env.DEFAULT_TIMEZONE,
    calendarProvider: getCalendarProvider(),
    googleCalendarConfigured: isGoogleCalendarConfigured(),
    yandexCalendarConfigured: isYandexCalendarConfigured(),
  });
}
