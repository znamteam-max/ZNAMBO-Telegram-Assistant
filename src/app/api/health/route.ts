import { NextResponse } from "next/server";

import { getEnv, isGoogleCalendarConfigured } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const env = getEnv();
  return NextResponse.json({
    ok: true,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    defaultTimezone: env.DEFAULT_TIMEZONE,
    googleCalendarConfigured: isGoogleCalendarConfigured(),
  });
}
