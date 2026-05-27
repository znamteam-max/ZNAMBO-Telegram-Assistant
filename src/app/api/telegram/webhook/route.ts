import { NextResponse } from "next/server";

import { getBot } from "@/bot/createBot";
import { requireEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { constantTimeEquals } from "@/lib/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = requireEnv("TELEGRAM_WEBHOOK_SECRET");
  const header = request.headers.get("x-telegram-bot-api-secret-token");
  if (!constantTimeEquals(header, secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const update = await request.json();
  try {
    await getBot().handleUpdate(update);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("Telegram webhook failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "telegram-webhook" });
}
