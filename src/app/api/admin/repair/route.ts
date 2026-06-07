import { NextResponse } from "next/server";

import { getAllowedTelegramUserIds, requireEnv } from "@/lib/env";
import { constantTimeEquals } from "@/lib/secrets";
import { getUserByTelegramId } from "@/db/queries/users";
import { createManualPlannerItem, getPlannerItemById } from "@/db/queries/items";
import {
  createReminderIfMissing,
  getLatestReminderDelivery,
  getLatestReminderForItem,
} from "@/db/queries/reminders";
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

  const body = (await request.json().catch(() => ({}))) as { action?: string; itemId?: string };
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
  if (body.action === "reminder_smoke") {
    const scheduledAt = new Date(Date.now() + 2 * 60 * 1000);
    const item = await createManualPlannerItem({
      userId: owner.id,
      kind: "task",
      title: "Production repair reminder smoke",
      timezone: owner.timezone,
      dueAt: scheduledAt,
      metadata: { isTest: true, source: "remindertest", debug: true },
    });
    await createReminderIfMissing({
      userId: owner.id,
      plannerItemId: item.id,
      type: "custom",
      idempotencyKey: `${item.id}:production-repair-smoke`,
      scheduledAt,
      payload: { title: item.title, isTest: true, source: "remindertest", debug: true },
    });
    return NextResponse.json({
      ok: true,
      action: "reminder_smoke",
      itemId: item.id,
      scheduledAt,
    });
  }
  if (body.action === "smoke_status" && typeof body.itemId === "string") {
    const item = await getPlannerItemById(owner.id, body.itemId);
    const reminder = await getLatestReminderForItem(owner.id, body.itemId);
    const delivery = reminder ? await getLatestReminderDelivery(reminder.id) : null;
    return NextResponse.json({
      ok: true,
      action: "smoke_status",
      itemStatus: item?.status ?? null,
      autoArchivedAfterDelivery: item?.metadata?.autoArchivedAfterDelivery === true,
      reminderStatus: reminder?.status ?? null,
      deliveryStatus: delivery?.status ?? null,
      deliveredAt: delivery?.deliveredAt ?? null,
    });
  }

  return NextResponse.json({ ok: false, error: "unsupported_action" }, { status: 400 });
}
