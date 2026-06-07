import { and, desc, eq, ne } from "drizzle-orm";

import { getDb } from "../client";
import { liveDashboards } from "../schema";

export async function getActiveDashboard(userId: string, chatId: string) {
  const [row] = await getDb()
    .select()
    .from(liveDashboards)
    .where(
      and(
        eq(liveDashboards.userId, userId),
        eq(liveDashboards.chatId, chatId),
        eq(liveDashboards.status, "active"),
      ),
    )
    .orderBy(desc(liveDashboards.createdAt))
    .limit(1);
  return row ?? null;
}

export async function createActiveDashboard(params: {
  userId: string;
  chatId: string;
  messageId: number;
  dashboardType?: string;
  payload?: Record<string, unknown>;
}) {
  await getDb()
    .update(liveDashboards)
    .set({ status: "stale", updatedAt: new Date() })
    .where(
      and(
        eq(liveDashboards.userId, params.userId),
        eq(liveDashboards.chatId, params.chatId),
        eq(liveDashboards.status, "active"),
      ),
    );
  const [row] = await getDb()
    .insert(liveDashboards)
    .values({
      userId: params.userId,
      chatId: params.chatId,
      messageId: params.messageId,
      dashboardType: params.dashboardType ?? "main",
      payload: params.payload ?? {},
    })
    .returning();
  if (!row) throw new Error("Live dashboard was not stored");
  return row;
}

export async function markDashboardStatus(id: string, status: string) {
  const [row] = await getDb()
    .update(liveDashboards)
    .set({ status, updatedAt: new Date() })
    .where(eq(liveDashboards.id, id))
    .returning();
  return row ?? null;
}

export async function markOtherDashboardsStale(userId: string, chatId: string, keepId: string) {
  await getDb()
    .update(liveDashboards)
    .set({ status: "stale", updatedAt: new Date() })
    .where(
      and(
        eq(liveDashboards.userId, userId),
        eq(liveDashboards.chatId, chatId),
        eq(liveDashboards.status, "active"),
        ne(liveDashboards.id, keepId),
      ),
    );
}
