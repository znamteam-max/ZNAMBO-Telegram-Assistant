import { NextResponse } from "next/server";

import { isAllowedTelegramUserId } from "@/bot/authorization";
import { exportOwnerData } from "@/db/queries/memories";
import { getUserByTelegramId } from "@/db/queries/users";
import { requireEnv } from "@/lib/env";
import { constantTimeEquals } from "@/lib/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = `Bearer ${requireEnv("CRON_SECRET")}`;
  if (!constantTimeEquals(request.headers.get("authorization"), expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const telegramUserId = request.headers.get("x-telegram-user-id");
  if (!telegramUserId || !isAllowedTelegramUserId(telegramUserId)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const user = await getUserByTelegramId(telegramUserId);
  if (!user) return NextResponse.json({ ok: false, error: "user_not_found" }, { status: 404 });

  return NextResponse.json(await exportOwnerData(user.id));
}
