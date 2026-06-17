import { NextResponse } from "next/server";

import {
  getCalendarProvider,
  getEnv,
  getOwnerTimezone,
  isGoogleCalendarConfigured,
  isYandexCalendarConfigured,
} from "@/lib/env";
import {
  getLatestAiAuditStatus,
  getLatestAuditByActionGlobal,
  getLatestPlannerGuardBlock,
} from "@/db/queries/audit";
import {
  APP_VERSION,
  INTERVAL_ALGORITHM_VERSION,
  POLICY_ENGINE_VERSION,
  RECONCILER_ENABLED,
  RUNNER_LOCK_ENABLED,
} from "@/lib/version";
import { getSchedulerRuntimeHealth } from "@/db/queries/schedulerHealth";
import { getReminderPolicyHealthStats } from "@/db/queries/reminderPolicies";
import { getLatestCalendarImportState } from "@/db/queries/externalCalendarEvents";
import { getLatestReleaseNotification } from "@/db/queries/releaseNotifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const env = getEnv();
  const [
    lastSuccessfulAi,
    lastAiCall,
    scheduler,
    policyStats,
    calendarImport,
    lastTranscription,
    lastNaturalLanguagePlan,
    lastPlannerGuardBlock,
    latestReleaseNotification,
  ] = await Promise.all([
    getLatestAiAuditStatus({ succeeded: true }).catch(() => null),
    getLatestAiAuditStatus().catch(() => null),
    getSchedulerRuntimeHealth().catch(() => null),
    getReminderPolicyHealthStats().catch(() => ({
      activePolicyCount: 0,
      policiesMissingNextReminder: 0,
    })),
    getLatestCalendarImportState().catch(() => null),
    getLatestAuditByActionGlobal("assistant.transcription_status").catch(() => null),
    getLatestAuditByActionGlobal("assistant.agent_decision_trace").catch(() => null),
    getLatestPlannerGuardBlock().catch(() => null),
    getLatestReleaseNotification().catch(() => null),
  ]);
  const lastSuccessfulDetails = lastSuccessfulAi?.details as Record<string, unknown> | undefined;
  const lastCallDetails = lastAiCall?.details as Record<string, unknown> | undefined;
  const lastTranscriptionDetails = lastTranscription?.details as
    | Record<string, unknown>
    | undefined;
  const lastPlanDetails = lastNaturalLanguagePlan?.details as Record<string, unknown> | undefined;
  const lastGuardDetails = lastPlannerGuardBlock?.details as Record<string, unknown> | undefined;
  const runnerStartedAt = scheduler?.lastRunnerStartedAt ?? null;
  const runnerFinishedAt = scheduler?.lastRunnerFinishedAt ?? null;
  const lastRunnerRunAt =
    runnerStartedAt && (!runnerFinishedAt || runnerStartedAt > runnerFinishedAt)
      ? runnerStartedAt
      : runnerFinishedAt;
  const lastRunnerSucceeded = scheduler
    ? Boolean(
        runnerFinishedAt &&
        (!runnerStartedAt || runnerFinishedAt >= runnerStartedAt) &&
        scheduler.lastRunnerFailed === 0,
      )
    : null;
  return NextResponse.json({
    ok: true,
    appVersion: APP_VERSION,
    deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    defaultTimezone: env.DEFAULT_TIMEZONE,
    ownerTimezone: getOwnerTimezone(),
    pipelineMode: env.JARVIS_MODE_ENABLED ? "jarvis" : "legacy_v2",
    jarvisModeEnabled: env.JARVIS_MODE_ENABLED,
    liveDashboardEnabled: true,
    reminderPolicyEngineEnabled: true,
    policyEngineVersion: POLICY_ENGINE_VERSION,
    intervalAlgorithmVersion: INTERVAL_ALGORITHM_VERSION,
    reconcilerEnabled: RECONCILER_ENABLED,
    runnerLockEnabled: RUNNER_LOCK_ENABLED,
    schedulerConfigured: Boolean(env.CRON_SECRET),
    lastRunnerRunAt: lastRunnerRunAt?.toISOString() ?? null,
    lastRunnerSucceeded,
    activePolicyCount: policyStats.activePolicyCount,
    policiesMissingNextReminder: policyStats.policiesMissingNextReminder,
    openAiConfigured: Boolean(env.OPENAI_API_KEY),
    openAiRequiredForNaturalLanguage: env.OPENAI_REQUIRED_FOR_NATURAL_LANGUAGE,
    lastSuccessfulAiCallAt: lastSuccessfulAi?.createdAt?.toISOString() ?? null,
    lastAiModel: String(lastSuccessfulDetails?.aiModel ?? lastCallDetails?.aiModel ?? "") || null,
    lastAiErrorType:
      lastCallDetails?.aiSucceeded === true
        ? null
        : String(lastCallDetails?.errorCode ?? "") || null,
    calendarProvider: getCalendarProvider(),
    googleCalendarConfigured: isGoogleCalendarConfigured(),
    yandexCalendarConfigured: isYandexCalendarConfigured(),
    lastCalendarImportAt: calendarImport?.lastImportAt?.toISOString() ?? null,
    externalCalendarEventsVisible: calendarImport?.externalEventsVisible ?? 0,
    recurringCalendarEventsImported: calendarImport?.recurringEventsCount ?? 0,
    lastCalendarImportErrorClass: calendarImport?.lastImportErrorClass ?? null,
    lastTranscriptionStatus: String(lastTranscriptionDetails?.status ?? "") || null,
    lastPlannerGuardBlockReason:
      String(
        lastGuardDetails?.plannerGuardBlockReason ??
          (Array.isArray(lastGuardDetails?.validationWarnings)
            ? lastGuardDetails.validationWarnings[0]
            : ""),
      ) || null,
    lastPlannerGuardBlockedAt: lastPlannerGuardBlock?.createdAt?.toISOString() ?? null,
    lastNaturalLanguagePlanAttemptAt: lastNaturalLanguagePlan?.createdAt?.toISOString() ?? null,
    lastNaturalLanguagePlanResult: String(lastPlanDetails?.finalAction ?? "") || null,
    latestReleaseNotification: latestReleaseNotification
      ? {
          version: latestReleaseNotification.version,
          commitSha: latestReleaseNotification.commitSha,
          status: latestReleaseNotification.status,
          sentAt: latestReleaseNotification.sentAt?.toISOString() ?? null,
        }
      : null,
  });
}
