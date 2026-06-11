import { and, desc, eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { getDb } from "@/db/client";
import { auditLog } from "@/db/schema";
import { listRecentRangeItems } from "@/db/queries/items";
import { entityListKeyboard } from "@/bot/keyboards";

export type DailyItemSnapshot = {
  itemId: string;
  title: string;
  kind: string;
  finalStatus: "completed" | "not_completed" | "cancelled" | "missed" | "unresolved";
  originalStartAt: string | null;
  originalDueAt: string | null;
  completedAt: string | null;
};

export async function ensureDailySnapshot(params: {
  userId: string;
  timezone: string;
  localDate: string;
}) {
  const existing = await findDailySnapshot(params.userId, params.localDate);
  if (existing) return existing;
  const local = DateTime.fromISO(params.localDate, { zone: params.timezone });
  const items = await listRecentRangeItems({
    userId: params.userId,
    from: local.startOf("day").toUTC().toJSDate(),
    to: local.endOf("day").toUTC().toJSDate(),
    limit: 200,
  });
  const snapshot: DailyItemSnapshot[] = items.map((item) => ({
    itemId: item.id,
    title: item.title,
    kind: item.kind,
    finalStatus:
      item.status === "completed"
        ? "completed"
        : item.status === "cancelled"
          ? "cancelled"
          : item.kind === "event" && (item.endAt ?? item.startAt ?? item.dueAt ?? new Date()) < new Date()
            ? "missed"
            : "unresolved",
    originalStartAt: item.startAt?.toISOString() ?? null,
    originalDueAt: item.dueAt?.toISOString() ?? null,
    completedAt: item.completedAt?.toISOString() ?? null,
  }));
  const [created] = await getDb()
    .insert(auditLog)
    .values({
      userId: params.userId,
      action: "assistant.daily_item_state",
      entityType: "daily_snapshot",
      details: { localDate: params.localDate, timezone: params.timezone, items: snapshot },
    })
    .returning();
  return created ?? null;
}

export async function renderDailyHistory(params: {
  userId: string;
  timezone: string;
  days?: number;
  endDate?: string;
}) {
  return (await renderDailyHistoryView(params)).text;
}

export async function renderDailyHistoryView(params: {
  userId: string;
  timezone: string;
  days?: number;
  endDate?: string;
}) {
  const end = params.endDate
    ? DateTime.fromISO(params.endDate, { zone: params.timezone })
    : DateTime.now().setZone(params.timezone).minus({ days: 1 });
  const days = Math.max(1, Math.min(7, params.days ?? 1));
  const snapshots = [];
  for (let offset = 0; offset < days; offset += 1) {
    const localDate = end.minus({ days: offset }).toISODate()!;
    snapshots.push(await ensureDailySnapshot({ ...params, localDate }));
  }
  const validSnapshots = snapshots.filter(Boolean);
  const refs = validSnapshots.flatMap((snapshot) => {
    const details = snapshot!.details as Record<string, unknown>;
    const items = Array.isArray(details.items) ? (details.items as DailyItemSnapshot[]) : [];
    return items.map((item) => ({ type: "history_item" as const, id: item.itemId }));
  });
  return {
    text: validSnapshots
    .filter(Boolean)
    .map((snapshot) => formatSnapshot(snapshot!.details as Record<string, unknown>))
    .join("\n\n"),
    keyboard: entityListKeyboard([...new Map(refs.map((ref) => [ref.id, ref])).values()]),
  };
}

async function findDailySnapshot(userId: string, localDate: string) {
  const [row] = await getDb()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, userId),
        eq(auditLog.action, "assistant.daily_item_state"),
        sql`${auditLog.details}->>'localDate' = ${localDate}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row ?? null;
}

function formatSnapshot(details: Record<string, unknown>) {
  const items = Array.isArray(details.items) ? (details.items as DailyItemSnapshot[]) : [];
  const completed = items.filter((item) => item.finalStatus === "completed");
  const unresolved = items.filter((item) => ["unresolved", "not_completed", "missed"].includes(item.finalStatus));
  const cancelled = items.filter((item) => item.finalStatus === "cancelled");
  const lines = [String(details.localDate ?? "Дата")];
  addSection(lines, "Выполнено", completed);
  addSection(lines, "Не выполнено", unresolved);
  addSection(lines, "Отменено", cancelled);
  if (!items.length) lines.push("", "Записей нет.");
  return lines.join("\n");
}

function addSection(lines: string[], title: string, items: DailyItemSnapshot[]) {
  if (!items.length) return;
  lines.push("", `${title}:`, ...items.map((item) => `• ${item.title}`));
}
