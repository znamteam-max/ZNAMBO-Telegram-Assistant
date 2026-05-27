import { NextResponse } from "next/server";

import { isAllowedTelegramUserId } from "@/bot/authorization";
import { createGoogleCalendarAuthUrl } from "@/integrations/googleCalendar";
import { isGoogleCalendarConfigured } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isGoogleCalendarConfigured()) {
    return NextResponse.json(
      { ok: false, error: "google_calendar_not_configured" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const telegramUserId = url.searchParams.get("telegram_user_id");
  if (!telegramUserId || !isAllowedTelegramUserId(telegramUserId)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  return NextResponse.redirect(createGoogleCalendarAuthUrl(telegramUserId));
}
