import { NextResponse } from "next/server";

import { getBot } from "@/bot/createBot";
import { finishGoogleCalendarOAuth } from "@/integrations/googleCalendar";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.json({ ok: false, error: "missing_code_or_state" }, { status: 400 });
  }

  try {
    const { user, connection } = await finishGoogleCalendarOAuth({ code, state });
    await getBot().api.sendMessage(
      user.telegramUserId.toString(),
      `Google Calendar подключён${connection.googleEmail ? `: ${connection.googleEmail}` : "."}`,
    );
    return new NextResponse(
      "<!doctype html><html><body><h1>Google Calendar подключён</h1><p>Можно закрыть вкладку.</p></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  } catch (error) {
    logger.warn("Google OAuth callback failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "oauth_failed" }, { status: 400 });
  }
}
