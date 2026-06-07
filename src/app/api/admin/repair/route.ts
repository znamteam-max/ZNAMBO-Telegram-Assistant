import { NextResponse } from "next/server";

import { getAllowedTelegramUserIds, requireEnv } from "@/lib/env";
import { constantTimeEquals } from "@/lib/secrets";
import { getUserByTelegramId } from "@/db/queries/users";
import {
  executeActivePlanReset,
  previewActivePlanReset,
} from "@/services/activePlanReset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const expected = `Bearer ${requireEnv("CRON_SECRET")}`;
  if (!constantTimeEquals(request.headers.get("authorization"), expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const ownerTelegramId = [...getAllowedTelegramUserIds()][0];
  if (!ownerTelegramId) {
    return NextResponse.json({ ok: false, error: "owner_not_configured" }, { status: 503 });
  }
  const owner = await getUserByTelegramId(ownerTelegramId);
  if (!owner) {
    return NextResponse.json({ ok: false, error: "owner_not_found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { action?: string };
  if (body.action === "preview") {
    const result = await previewActivePlanReset({ userId: owner.id, mode: "garbage" });
    return NextResponse.json({
      ok: true,
      action: "preview",
      preview: result.preview,
      titles: result.selectedItems.map((item) => item.title),
    });
  }
  if (body.action === "apply") {
    const result = await executeActivePlanReset({
      userId: owner.id,
      mode: "garbage",
      reason: "one_time_production_repair",
    });
    return NextResponse.json({
      ok: true,
      action: "apply",
      archivedCount: result.items.length,
      titles: result.items.map((item) => item.title),
    });
  }

  return NextResponse.json({ ok: false, error: "unsupported_action" }, { status: 400 });
}
