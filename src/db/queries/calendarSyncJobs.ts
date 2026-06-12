import { and, count, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { getDb } from "../client";
import { calendarSyncJobs, plannerItems } from "../schema";

const AUTOMATIC_RETRY_JOB_STATUSES = ["pending", "pending_retry"];
const MANUAL_RETRY_JOB_STATUSES = [...AUTOMATIC_RETRY_JOB_STATUSES, "failed"];

export async function upsertCalendarSyncJob(params: {
  plannerItemId: string;
  provider: string;
  status: "pending" | "syncing" | "synced" | "pending_retry" | "failed" | "disabled";
  lastError?: string | null;
  nextAttemptAt?: Date | null;
  payload?: Record<string, unknown>;
  incrementAttempt?: boolean;
}) {
  const now = new Date();
  const existing = await getCalendarSyncJobForItem(params.plannerItemId, params.provider);
  const attemptCount = (existing?.attemptCount ?? 0) + (params.incrementAttempt ? 1 : 0);
  const [job] = await getDb()
    .insert(calendarSyncJobs)
    .values({
      plannerItemId: params.plannerItemId,
      provider: params.provider,
      status: params.status,
      attemptCount,
      lastError: params.lastError?.slice(0, 1000) ?? null,
      nextAttemptAt: params.nextAttemptAt ?? null,
      payload: params.payload ?? {},
    })
    .onConflictDoUpdate({
      target: [calendarSyncJobs.plannerItemId, calendarSyncJobs.provider],
      set: {
        status: params.status,
        attemptCount,
        lastError: params.lastError?.slice(0, 1000) ?? null,
        nextAttemptAt: params.nextAttemptAt ?? null,
        payload: params.payload ?? existing?.payload ?? {},
        updatedAt: now,
      },
    })
    .returning();
  return job;
}

export async function getCalendarSyncJobForItem(plannerItemId: string, provider: string) {
  const [job] = await getDb()
    .select()
    .from(calendarSyncJobs)
    .where(
      and(
        eq(calendarSyncJobs.plannerItemId, plannerItemId),
        eq(calendarSyncJobs.provider, provider),
      ),
    )
    .limit(1);
  return job ?? null;
}

export async function listDueCalendarSyncJobs(now = new Date(), limit = 20) {
  return getDb()
    .select({ job: calendarSyncJobs, item: plannerItems })
    .from(calendarSyncJobs)
    .innerJoin(plannerItems, eq(calendarSyncJobs.plannerItemId, plannerItems.id))
    .where(
      and(
        inArray(calendarSyncJobs.status, AUTOMATIC_RETRY_JOB_STATUSES),
        or(isNull(calendarSyncJobs.nextAttemptAt), lte(calendarSyncJobs.nextAttemptAt, now)),
      ),
    )
    .orderBy(calendarSyncJobs.nextAttemptAt, calendarSyncJobs.updatedAt)
    .limit(limit);
}

export async function listRetryableCalendarSyncJobsForUser(userId: string, limit = 100) {
  return getDb()
    .select({ job: calendarSyncJobs, item: plannerItems })
    .from(calendarSyncJobs)
    .innerJoin(plannerItems, eq(calendarSyncJobs.plannerItemId, plannerItems.id))
    .where(
      and(
        eq(plannerItems.userId, userId),
        inArray(calendarSyncJobs.status, MANUAL_RETRY_JOB_STATUSES),
      ),
    )
    .orderBy(desc(calendarSyncJobs.updatedAt))
    .limit(limit);
}

export async function countPendingCalendarSyncJobsForUser(userId: string) {
  const [result] = await getDb()
    .select({ count: count() })
    .from(calendarSyncJobs)
    .innerJoin(plannerItems, eq(calendarSyncJobs.plannerItemId, plannerItems.id))
    .where(
      and(
        eq(plannerItems.userId, userId),
        inArray(calendarSyncJobs.status, ["pending", "pending_retry", "syncing"]),
      ),
    );
  return Number(result?.count ?? 0);
}

export async function disableCalendarSyncForItem(plannerItemId: string, provider: string) {
  return upsertCalendarSyncJob({
    plannerItemId,
    provider,
    status: "disabled",
    lastError: null,
    nextAttemptAt: null,
    payload: { disabledByUser: true },
  });
}
