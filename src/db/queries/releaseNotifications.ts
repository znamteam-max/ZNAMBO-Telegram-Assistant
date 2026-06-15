import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../client";
import { releaseNotifications, type ReleaseNotification } from "../schema";

export type ReleaseNotificationKey = {
  version: string;
  commitSha: string;
  environment: string;
};

export async function getReleaseNotification(
  key: ReleaseNotificationKey,
): Promise<ReleaseNotification | null> {
  const [row] = await getDb()
    .select()
    .from(releaseNotifications)
    .where(
      and(
        eq(releaseNotifications.version, key.version),
        eq(releaseNotifications.commitSha, key.commitSha),
        eq(releaseNotifications.environment, key.environment),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getLatestReleaseNotification(): Promise<ReleaseNotification | null> {
  const [row] = await getDb()
    .select()
    .from(releaseNotifications)
    .orderBy(desc(releaseNotifications.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getLatestSentReleaseForVersion(
  version: string,
  environment: string,
): Promise<ReleaseNotification | null> {
  const [row] = await getDb()
    .select()
    .from(releaseNotifications)
    .where(
      and(
        eq(releaseNotifications.version, version),
        eq(releaseNotifications.environment, environment),
        eq(releaseNotifications.status, "sent"),
      ),
    )
    .orderBy(desc(releaseNotifications.sentAt))
    .limit(1);
  return row ?? null;
}

export async function reserveReleaseNotification(params: {
  key: ReleaseNotificationKey;
  summary: Record<string, unknown>;
}): Promise<
  | { state: "reserved"; notification: ReleaseNotification }
  | { state: "already_sent" | "in_progress"; notification: ReleaseNotification }
> {
  const now = new Date();
  const [inserted] = await getDb()
    .insert(releaseNotifications)
    .values({
      ...params.key,
      status: "pending",
      summary: params.summary,
      attemptCount: 1,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) return { state: "reserved", notification: inserted };

  const existing = await getReleaseNotification(params.key);
  if (!existing) {
    throw new Error("release_notification_reservation_lost");
  }
  if (existing.status === "sent") {
    return { state: "already_sent", notification: existing };
  }
  if (existing.status !== "failed") {
    return { state: "in_progress", notification: existing };
  }

  const [retried] = await getDb()
    .update(releaseNotifications)
    .set({
      status: "pending",
      summary: params.summary,
      lastError: null,
      attemptCount: existing.attemptCount + 1,
      updatedAt: now,
    })
    .where(and(eq(releaseNotifications.id, existing.id), eq(releaseNotifications.status, "failed")))
    .returning();

  return retried
    ? { state: "reserved", notification: retried }
    : {
        state: "in_progress",
        notification: (await getReleaseNotification(params.key)) ?? existing,
      };
}

export async function markReleaseNotificationSent(params: {
  id: string;
  telegramMessageId: bigint;
  summary: Record<string, unknown>;
}): Promise<ReleaseNotification> {
  const now = new Date();
  const [row] = await getDb()
    .update(releaseNotifications)
    .set({
      status: "sent",
      sentAt: now,
      telegramMessageId: params.telegramMessageId,
      summary: params.summary,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(releaseNotifications.id, params.id))
    .returning();
  if (!row) throw new Error("release_notification_not_found");
  return row;
}

export async function markReleaseNotificationFailed(params: {
  id: string;
  error: string;
  summary: Record<string, unknown>;
}): Promise<ReleaseNotification> {
  const now = new Date();
  const [row] = await getDb()
    .update(releaseNotifications)
    .set({
      status: "failed",
      lastError: params.error.slice(0, 200),
      summary: params.summary,
      updatedAt: now,
    })
    .where(eq(releaseNotifications.id, params.id))
    .returning();
  if (!row) throw new Error("release_notification_not_found");
  return row;
}
