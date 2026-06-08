import { DateTime } from "luxon";

import { getSchedulerRuntimeHealth } from "@/db/queries/schedulerHealth";
import {
  getLatestPolicyDebug,
  getReminderPolicyHealthStats,
} from "@/db/queries/reminderPolicies";
import { getEnv } from "@/lib/env";

export async function renderCronHealth(timezone: string) {
  const [health, stats] = await Promise.all([
    getSchedulerRuntimeHealth(),
    getReminderPolicyHealthStats(),
  ]);
  const startedAt = health?.lastRunnerStartedAt ?? null;
  const finishedAt = health?.lastRunnerFinishedAt ?? null;
  const lastRun =
    startedAt && (!finishedAt || startedAt > finishedAt) ? startedAt : finishedAt;
  const lastRunSucceeded = Boolean(
    health &&
      finishedAt &&
      (!startedAt || finishedAt >= startedAt) &&
      health.lastRunnerFailed === 0,
  );
  const active =
    Boolean(getEnv().CRON_SECRET) &&
    lastRunSucceeded &&
    Boolean(lastRun && Date.now() - lastRun.getTime() <= 5 * 60 * 1000);
  return [
    `Scheduler: ${active ? "active" : "stale or not observed"}`,
    `Последний запуск: ${formatDate(lastRun, timezone)}`,
    "Ожидаемый интервал: около 1 минуты",
    `Claimed: ${health?.lastRunnerClaimed ?? 0}`,
    `Sent: ${health?.lastRunnerSent ?? 0}`,
    `Failed: ${health?.lastRunnerFailed ?? 0}`,
    `Policy reconcile: ${health?.lastPolicyReconcileChecked ?? 0} проверено, ${health?.lastPolicyReconcileCreated ?? 0} материализовано`,
    `Активных policies: ${stats.activePolicyCount}`,
    `Без следующего pending reminder: ${stats.policiesMissingNextReminder}`,
  ].join("\n");
}

export async function renderPolicyDebug(params: {
  userId: string;
  timezone: string;
  policyId?: string | null;
}) {
  const [debug, scheduler] = await Promise.all([
    getLatestPolicyDebug(params.userId, params.policyId),
    getSchedulerRuntimeHealth(),
  ]);
  if (!debug) {
    return [
      "Reminder policy не найдена.",
      "Если задача видна как обычная заметка, регулярные уведомления продолжаться не будут.",
    ].join("\n");
  }
  const { policy, occurrence } = debug;
  const window =
    policy.startsAt || policy.endsAt
      ? `${formatTime(policy.startsAt, params.timezone)}–${formatTime(policy.endsAt, params.timezone)}`
      : "нет";
  return [
    `Policy: ${policy.title}`,
    `Status: ${policy.status}`,
    `Type: ${policy.policyType}`,
    `Category: ${policy.category}`,
    `Window: ${window}`,
    `Interval: ${policy.intervalMinutes ? `${policy.intervalMinutes} minutes` : "нет"}`,
    `Require ack: ${policy.requireAck ? "true" : "false"}`,
    `Catch-up: ${policy.catchUpMode}`,
    `Next fire: ${formatDate(policy.nextFireAt, params.timezone)}`,
    `Last scheduled: ${formatDate(occurrence?.occurrence.scheduledFor, params.timezone)}`,
    `Last delivered: ${formatDate(occurrence?.occurrence.deliveredAt, params.timezone)}`,
    `Pending reminder: ${["pending", "claimed"].includes(occurrence?.reminder?.status ?? "") ? "yes" : "no"}`,
    `Cron last run: ${formatDate(scheduler?.lastRunnerFinishedAt, params.timezone)}`,
  ].join("\n");
}

function formatDate(value: Date | null | undefined, timezone: string) {
  return value
    ? DateTime.fromJSDate(value, { zone: "utc" })
        .setZone(timezone)
        .setLocale("ru")
        .toFormat("dd.LL HH:mm")
    : "нет";
}

function formatTime(value: Date | null | undefined, timezone: string) {
  return value
    ? DateTime.fromJSDate(value, { zone: "utc" }).setZone(timezone).toFormat("HH:mm")
    : "?";
}
