import { NextResponse } from "next/server";

import {
  getCalendarProvider,
  getEnv,
  isGoogleCalendarConfigured,
  isYandexCalendarConfigured,
} from "@/lib/env";
import { getLatestAiAuditStatus } from "@/db/queries/audit";
import { APP_VERSION } from "@/lib/version";
import { getSchedulerRuntimeHealth } from "@/db/queries/schedulerHealth";
import { getReminderPolicyHealthStats } from "@/db/queries/reminderPolicies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const env = getEnv();
  const [lastSuccessfulAi, lastAiCall, scheduler, policyStats] = await Promise.all([
    getLatestAiAuditStatus({ succeeded: true }).catch(() => null),
    getLatestAiAuditStatus().catch(() => null),
    getSchedulerRuntimeHealth().catch(() => null),
    getReminderPolicyHealthStats().catch(() => ({
      activePolicyCount: 0,
      policiesMissingNextReminder: 0,
    })),
  ]);
  const lastSuccessfulDetails = lastSuccessfulAi?.details as Record<string, unknown> | undefined;
  const lastCallDetails = lastAiCall?.details as Record<string, unknown> | undefined;
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
    pipelineMode: env.JARVIS_MODE_ENABLED ? "jarvis" : "legacy_v2",
    jarvisModeEnabled: env.JARVIS_MODE_ENABLED,
    liveDashboardEnabled: true,
    reminderPolicyEngineEnabled: true,
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
      lastCallDetails?.aiSucceeded === true ? null : String(lastCallDetails?.errorCode ?? "") || null,
    calendarProvider: getCalendarProvider(),
    googleCalendarConfigured: isGoogleCalendarConfigured(),
    yandexCalendarConfigured: isYandexCalendarConfigured(),
  });
}
