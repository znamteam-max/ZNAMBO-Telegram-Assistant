import { eq } from "drizzle-orm";

import { getDb } from "../client";
import { schedulerRuntimeHealth } from "../schema";

const HEALTH_KEY = "reminder_runner";

export async function recordRunnerStarted(startedAt: Date) {
  await getDb()
    .insert(schedulerRuntimeHealth)
    .values({
      key: HEALTH_KEY,
      lastRunnerStartedAt: startedAt,
      lastSchedulerHitAt: startedAt,
      lastError: null,
    })
    .onConflictDoUpdate({
      target: schedulerRuntimeHealth.key,
      set: {
        lastRunnerStartedAt: startedAt,
        lastSchedulerHitAt: startedAt,
        lastError: null,
        updatedAt: startedAt,
      },
    });
}

export async function recordPolicyReconcile(params: {
  at: Date;
  checked: number;
  created: number;
}) {
  await getDb()
    .insert(schedulerRuntimeHealth)
    .values({
      key: HEALTH_KEY,
      lastPolicyReconcileAt: params.at,
      lastPolicyReconcileChecked: params.checked,
      lastPolicyReconcileCreated: params.created,
    })
    .onConflictDoUpdate({
      target: schedulerRuntimeHealth.key,
      set: {
        lastPolicyReconcileAt: params.at,
        lastPolicyReconcileChecked: params.checked,
        lastPolicyReconcileCreated: params.created,
        updatedAt: params.at,
      },
    });
}

export async function recordRunnerFinished(params: {
  at: Date;
  claimed: number;
  sent: number;
  failed: number;
  error?: string | null;
}) {
  await getDb()
    .insert(schedulerRuntimeHealth)
    .values({
      key: HEALTH_KEY,
      lastRunnerFinishedAt: params.at,
      lastRunnerClaimed: params.claimed,
      lastRunnerSent: params.sent,
      lastRunnerFailed: params.failed,
      lastError: params.error?.slice(0, 1000) ?? null,
    })
    .onConflictDoUpdate({
      target: schedulerRuntimeHealth.key,
      set: {
        lastRunnerFinishedAt: params.at,
        lastRunnerClaimed: params.claimed,
        lastRunnerSent: params.sent,
        lastRunnerFailed: params.failed,
        lastError: params.error?.slice(0, 1000) ?? null,
        updatedAt: params.at,
      },
    });
}

export async function getSchedulerRuntimeHealth() {
  const [row] = await getDb()
    .select()
    .from(schedulerRuntimeHealth)
    .where(eq(schedulerRuntimeHealth.key, HEALTH_KEY))
    .limit(1);
  return row ?? null;
}
