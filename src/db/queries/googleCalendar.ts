import { desc, eq } from "drizzle-orm";

import { getDb } from "../client";
import {
  googleCalendarConnections,
  itemSyncState,
  plannerItems,
  type GoogleCalendarConnection,
  type PlannerItem,
} from "../schema";

export async function getGoogleCalendarConnection(
  userId: string,
): Promise<GoogleCalendarConnection | null> {
  const [connection] = await getDb()
    .select()
    .from(googleCalendarConnections)
    .where(eq(googleCalendarConnections.userId, userId))
    .limit(1);
  return connection ?? null;
}

export async function upsertGoogleCalendarConnection(params: {
  userId: string;
  googleEmail?: string | null;
  calendarId: string;
  encryptedRefreshToken: string;
  accessTokenExpiresAt?: Date | null;
}) {
  const now = new Date();
  const [connection] = await getDb()
    .insert(googleCalendarConnections)
    .values({
      userId: params.userId,
      googleEmail: params.googleEmail,
      calendarId: params.calendarId,
      encryptedRefreshToken: params.encryptedRefreshToken,
      accessTokenExpiresAt: params.accessTokenExpiresAt,
      status: "connected",
    })
    .onConflictDoUpdate({
      target: googleCalendarConnections.userId,
      set: {
        googleEmail: params.googleEmail,
        calendarId: params.calendarId,
        encryptedRefreshToken: params.encryptedRefreshToken,
        accessTokenExpiresAt: params.accessTokenExpiresAt,
        status: "connected",
        updatedAt: now,
      },
    })
    .returning();
  return connection;
}

export async function getItemGoogleSyncState(plannerItemId: string) {
  const [syncState] = await getDb()
    .select()
    .from(itemSyncState)
    .where(eq(itemSyncState.plannerItemId, plannerItemId))
    .limit(1);
  return syncState ?? null;
}

export async function getLatestCalendarSyncStateForUser(userId: string) {
  const [syncState] = await getDb()
    .select({ sync: itemSyncState, item: plannerItems })
    .from(itemSyncState)
    .innerJoin(plannerItems, eq(itemSyncState.plannerItemId, plannerItems.id))
    .where(eq(plannerItems.userId, userId))
    .orderBy(desc(itemSyncState.updatedAt))
    .limit(1);
  return syncState ?? null;
}

export async function listCalendarSyncStatesForUser(userId: string, limit = 100) {
  return getDb()
    .select({ sync: itemSyncState, item: plannerItems })
    .from(itemSyncState)
    .innerJoin(plannerItems, eq(itemSyncState.plannerItemId, plannerItems.id))
    .where(eq(plannerItems.userId, userId))
    .orderBy(desc(itemSyncState.updatedAt))
    .limit(limit);
}

export async function markGoogleCalendarSync(params: {
  item: PlannerItem;
  externalId?: string | null;
  status: "synced" | "error" | "not_synced";
  lastError?: string | null;
  provider?: string;
}) {
  const now = new Date();
  await getDb()
    .insert(itemSyncState)
    .values({
      plannerItemId: params.item.id,
      provider: params.provider ?? "google_calendar",
      externalId: params.externalId,
      status: params.status,
      lastError: params.lastError?.slice(0, 1000),
      syncedAt: params.status === "synced" ? now : null,
    })
    .onConflictDoUpdate({
      target: [itemSyncState.plannerItemId, itemSyncState.provider],
      set: {
        externalId: params.externalId,
        status: params.status,
        lastError: params.lastError?.slice(0, 1000),
        syncedAt: params.status === "synced" ? now : null,
        updatedAt: now,
      },
    });
}
