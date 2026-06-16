import type { ReleaseNotification } from "@/db/schema";
import {
  getLatestReleaseNotification,
  getLatestSentReleaseForVersion,
  markReleaseNotificationFailed,
  markReleaseNotificationSent,
  reserveReleaseNotification,
} from "@/db/queries/releaseNotifications";
import { getAllowedTelegramUserIds, getEnv, requireEnv } from "@/lib/env";
import {
  RELEASE_NOTES,
  displayReleaseVersion,
  normalizeReleaseVersion,
  shortCommit,
} from "@/lib/releaseMetadata";

type HealthPayload = {
  ok?: boolean;
  appVersion?: string;
  deploymentCommit?: string | null;
  schedulerConfigured?: boolean;
  lastRunnerSucceeded?: boolean | null;
  lastRunnerRunAt?: string | null;
};

type WebhookPayload = {
  ok?: boolean;
  result?: {
    url?: string;
    pending_update_count?: number;
    last_error_date?: number;
    last_error_message?: string;
  };
};

export type ReleaseInspection = {
  healthOk: boolean;
  version: string | null;
  commitSha: string | null;
  webhookOk: boolean;
  runnerOk: boolean;
  schedulerConfigured: boolean;
  lastRunnerRunAt: string | null;
  warnings: string[];
};

export type ReleaseNotificationStore = {
  getLatest(): Promise<ReleaseNotification | null>;
  getLatestSentForVersion(
    version: string,
    environment: string,
  ): Promise<ReleaseNotification | null>;
  reserve(params: {
    key: { version: string; commitSha: string; environment: string };
    summary: Record<string, unknown>;
  }): ReturnType<typeof reserveReleaseNotification>;
  markSent(params: {
    id: string;
    telegramMessageId: bigint;
    summary: Record<string, unknown>;
  }): Promise<ReleaseNotification>;
  markFailed(params: {
    id: string;
    error: string;
    summary: Record<string, unknown>;
  }): Promise<ReleaseNotification>;
};

export type ReleaseNotificationDependencies = {
  store: ReleaseNotificationStore;
  inspect(): Promise<ReleaseInspection>;
  send(params: { telegramUserId: string; text: string }): Promise<{ messageId: bigint }>;
};

export type NotifyProductionReleaseInput = {
  version: string;
  commitSha: string;
  environment?: string;
  summary?: string[];
  tests?: string[];
  handoffUpdated: boolean;
  allowHotfix?: boolean;
};

export type NotifyProductionReleaseResult = {
  ok: boolean;
  sent: boolean;
  reason?: string;
  version: string;
  commitSha: string;
  telegramMessageId?: string;
  sentAt?: string | null;
  warnings?: string[];
};

const defaultStore: ReleaseNotificationStore = {
  getLatest: getLatestReleaseNotification,
  getLatestSentForVersion: getLatestSentReleaseForVersion,
  reserve: reserveReleaseNotification,
  markSent: markReleaseNotificationSent,
  markFailed: markReleaseNotificationFailed,
};

export async function notifyProductionRelease(
  input: NotifyProductionReleaseInput,
  dependencies: ReleaseNotificationDependencies = {
    store: defaultStore,
    inspect: inspectProductionRelease,
    send: sendTelegramReleaseMessage,
  },
): Promise<NotifyProductionReleaseResult> {
  const version = normalizeReleaseVersion(input.version);
  const commitSha = input.commitSha.trim();
  const environment = input.environment?.trim() || "production";
  const summary = releaseSummaryOrFallback(input.summary);
  const tests = sanitizeReleaseLines(input.tests ?? []);

  if (!input.handoffUpdated) {
    return blocked("handoff_not_updated");
  }
  if (!hasCompletionEvidence(tests, "migrations")) {
    return blocked("migrations_not_verified");
  }
  if (!hasCompletionEvidence(tests, "smoke")) {
    return blocked("smoke_not_recorded");
  }
  if (!commitSha || commitSha === "unknown") {
    return blocked("commit_missing");
  }

  let inspection: ReleaseInspection;
  try {
    inspection = await dependencies.inspect();
  } catch {
    return blocked("health_unavailable");
  }

  if (!inspection.healthOk) return blocked("health_failed", inspection.warnings);
  if (normalizeReleaseVersion(inspection.version ?? "") !== version) {
    return blocked("version_mismatch", inspection.warnings);
  }
  if ((inspection.commitSha ?? "").trim() !== commitSha) {
    return blocked("commit_mismatch", inspection.warnings);
  }
  if (!inspection.webhookOk) return blocked("webhook_unhealthy", inspection.warnings);
  if (!inspection.schedulerConfigured || !inspection.runnerOk) {
    return blocked("runner_unhealthy", inspection.warnings);
  }

  const priorForVersion = await dependencies.store.getLatestSentForVersion(version, environment);
  if (priorForVersion && priorForVersion.commitSha !== commitSha && input.allowHotfix !== true) {
    return blocked("hotfix_requires_explicit_allow", inspection.warnings);
  }

  const safeRecord = {
    version,
    commitSha,
    environment,
    summary,
    tests,
    handoffUpdated: true,
    health: {
      healthOk: inspection.healthOk,
      webhookOk: inspection.webhookOk,
      runnerOk: inspection.runnerOk,
      schedulerConfigured: inspection.schedulerConfigured,
      lastRunnerRunAt: inspection.lastRunnerRunAt,
      warnings: inspection.warnings,
    },
  };
  const reservation = await dependencies.store.reserve({
    key: { version, commitSha, environment },
    summary: safeRecord,
  });
  if (reservation.state === "already_sent") {
    return {
      ok: true,
      sent: false,
      reason: "already_sent",
      version,
      commitSha,
      telegramMessageId: reservation.notification.telegramMessageId?.toString(),
      sentAt: reservation.notification.sentAt?.toISOString() ?? null,
      warnings: inspection.warnings,
    };
  }
  if (reservation.state === "in_progress") {
    return {
      ok: true,
      sent: false,
      reason: "in_progress",
      version,
      commitSha,
      warnings: inspection.warnings,
    };
  }

  const ownerTelegramId = [...getAllowedTelegramUserIds()][0];
  if (!ownerTelegramId) {
    await dependencies.store.markFailed({
      id: reservation.notification.id,
      error: "owner_not_configured",
      summary: safeRecord,
    });
    return blocked("owner_not_configured", inspection.warnings);
  }

  const text = buildReleaseNotificationText({
    version,
    commitSha,
    summary,
    tests,
    inspection,
    hotfix: Boolean(priorForVersion && priorForVersion.commitSha !== commitSha),
  });

  try {
    const sent = await dependencies.send({ telegramUserId: ownerTelegramId, text });
    const record = await dependencies.store.markSent({
      id: reservation.notification.id,
      telegramMessageId: sent.messageId,
      summary: safeRecord,
    });
    return {
      ok: true,
      sent: true,
      version,
      commitSha,
      telegramMessageId: record.telegramMessageId?.toString(),
      sentAt: record.sentAt?.toISOString() ?? null,
      warnings: inspection.warnings,
    };
  } catch {
    await dependencies.store.markFailed({
      id: reservation.notification.id,
      error: "telegram_send_failed",
      summary: safeRecord,
    });
    return blocked("telegram_send_failed", inspection.warnings);
  }

  function blocked(reason: string, warnings: string[] = []): NotifyProductionReleaseResult {
    return {
      ok: false,
      sent: false,
      reason,
      version,
      commitSha,
      warnings,
    };
  }
}

export async function getReleaseOverview(
  dependencies: Pick<ReleaseNotificationDependencies, "store" | "inspect"> = {
    store: defaultStore,
    inspect: inspectProductionRelease,
  },
) {
  const [inspection, latest] = await Promise.all([
    dependencies.inspect().catch(
      (): ReleaseInspection => ({
        healthOk: false,
        version: null,
        commitSha: null,
        webhookOk: false,
        runnerOk: false,
        schedulerConfigured: false,
        lastRunnerRunAt: null,
        warnings: ["production_status_unavailable"],
      }),
    ),
    dependencies.store.getLatest().catch(() => null),
  ]);
  return { inspection, latest };
}

export async function inspectProductionRelease(): Promise<ReleaseInspection> {
  const env = getEnv();
  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  const [healthResponse, webhookResponse] = await Promise.all([
    fetch(`${appUrl}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    }),
    fetch(`https://api.telegram.org/bot${requireEnv("TELEGRAM_BOT_TOKEN")}/getWebhookInfo`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    }),
  ]);
  const health = (await healthResponse.json().catch(() => null)) as HealthPayload | null;
  const webhook = (await webhookResponse.json().catch(() => null)) as WebhookPayload | null;
  const expectedWebhookUrl = `${appUrl}/api/telegram/webhook`;
  const pendingCount = webhook?.result?.pending_update_count ?? 0;
  const lastErrorDate = webhook?.result?.last_error_date ?? null;
  const recentError =
    lastErrorDate !== null && Date.now() / 1000 - lastErrorDate < 10 * 60 && pendingCount > 0;
  const lastRunnerRunAt = health?.lastRunnerRunAt ?? null;
  const runnerAgeMs = lastRunnerRunAt
    ? Date.now() - new Date(lastRunnerRunAt).getTime()
    : Number.POSITIVE_INFINITY;
  const runnerFresh =
    Number.isFinite(runnerAgeMs) && runnerAgeMs >= 0 && runnerAgeMs <= 10 * 60_000;
  const warnings: string[] = [];
  if (lastErrorDate !== null && !recentError) warnings.push("historical_webhook_error");
  if (pendingCount > 0) warnings.push(`pending_webhook_updates:${pendingCount}`);
  if (!runnerFresh) warnings.push("runner_status_stale");

  return {
    healthOk: healthResponse.ok && health?.ok === true,
    version: health?.appVersion ?? null,
    commitSha: health?.deploymentCommit ?? null,
    webhookOk:
      webhookResponse.ok &&
      webhook?.ok === true &&
      webhook.result?.url === expectedWebhookUrl &&
      !recentError,
    runnerOk: health?.lastRunnerSucceeded === true && runnerFresh,
    schedulerConfigured: health?.schedulerConfigured === true,
    lastRunnerRunAt,
    warnings,
  };
}

export function buildReleaseNotificationText(params: {
  version: string;
  commitSha: string;
  summary: string[];
  tests: string[];
  inspection: ReleaseInspection;
  hotfix?: boolean;
}): string {
  const heading = params.hotfix
    ? "✅ JARVIS: фикс загружен"
    : `✅ JARVIS обновлён до ${displayReleaseVersion(params.version)}`;
  return [
    heading,
    "",
    "Что изменилось:",
    ...sanitizeReleaseLines(params.summary).map((line) => `— ${line}`),
    "",
    `Production: ${shortCommit(params.commitSha)}`,
    `Статус: health ok, webhook ok, runner ok`,
    params.inspection.warnings.length
      ? `Примечание: ${sanitizeReleaseLines(params.inspection.warnings).join(", ")}`
      : null,
    params.tests.length ? `Проверки: ${sanitizeReleaseLines(params.tests).join(", ")}` : null,
    `Проверить: ${RELEASE_NOTES.testPrompts.join(", ")}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderVersionMessage(params: {
  inspection: ReleaseInspection;
  latest: ReleaseNotification | null;
}): string {
  const latest = params.latest;
  return [
    "JARVIS",
    `Версия: ${displayReleaseVersion(params.inspection.version ?? RELEASE_NOTES.version)}`,
    `Коммит: ${shortCommit(params.inspection.commitSha)}`,
    `Production: ${params.inspection.healthOk ? "ok" : "unavailable"}`,
    `Webhook: ${params.inspection.webhookOk ? "ok" : "error"}`,
    `Runner: ${params.inspection.runnerOk ? "ok" : "error"}`,
    latest
      ? `Последнее уведомление: ${latest.status}${
          latest.sentAt ? `, ${formatReleaseTimestamp(latest.sentAt)}` : ""
        }`
      : "Последнее уведомление: ещё не отправлялось",
  ].join("\n");
}

export function renderReleaseNotesMessage(): string {
  return [
    displayReleaseVersion(RELEASE_NOTES.version),
    ...RELEASE_NOTES.bullets.map((bullet) => `— ${bullet}`),
    "",
    `Предыдущая версия: ${displayReleaseVersion(RELEASE_NOTES.previousVersion)}`,
  ].join("\n");
}

export function renderReleaseNotifyResult(result: NotifyProductionReleaseResult): string {
  if (result.sent) {
    return `Уведомление по ${displayReleaseVersion(result.version)} отправлено.`;
  }
  if (result.reason === "already_sent") {
    return `Уведомление по ${displayReleaseVersion(result.version)} уже отправлено${
      result.sentAt ? `: ${formatReleaseTimestamp(new Date(result.sentAt))}` : ""
    }.`;
  }
  const reasons: Record<string, string> = {
    version_mismatch: "версия production не совпадает",
    commit_mismatch: "commit production не совпадает",
    health_failed: "production health не прошёл",
    health_unavailable: "production health недоступен",
    webhook_unhealthy: "Telegram webhook не готов",
    runner_unhealthy: "runner/scheduler не готов",
    handoff_not_updated: "handoff ещё не обновлён",
    migrations_not_verified: "миграции не подтверждены",
    smoke_not_recorded: "smoke-проверка не подтверждена",
    hotfix_requires_explicit_allow: "hotfix требует явного разрешения",
    telegram_send_failed: "Telegram не принял сообщение; можно повторить",
    in_progress: "отправка уже выполняется",
    commit_missing: "commit не определён",
  };
  return `Не отправляю уведомление: ${reasons[result.reason ?? ""] ?? result.reason ?? "unknown_error"}.`;
}

export function renderReleaseHandoffChecklist(params: {
  notificationStatus: "sent" | "failed" | "skipped";
  telegramMessageId?: string | null;
  idempotencyVerified: boolean;
}): string {
  return [
    `Release notification: ${params.notificationStatus}`,
    `Telegram message id: ${params.telegramMessageId ?? "none"}`,
    `Notification idempotency: ${params.idempotencyVerified ? "verified" : "not verified"}`,
  ].join("\n");
}

export function sanitizeReleaseLines(lines: readonly string[]): string[] {
  return lines
    .map((line) =>
      line
        .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
        .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
        .replace(
          /\b(?:DATABASE_URL|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|CRON_SECRET|YANDEX_CALDAV_APP_PASSWORD)\s*=\s*\S+/gi,
          "[redacted]",
        )
        .trim()
        .slice(0, 240),
    )
    .filter(Boolean)
    .slice(0, 12);
}

function hasCompletionEvidence(tests: string[], name: string): boolean {
  return tests.some((test) => test.toLowerCase().startsWith(name));
}

function formatReleaseTimestamp(value: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

async function sendTelegramReleaseMessage(params: {
  telegramUserId: string;
  text: string;
}): Promise<{ messageId: bigint }> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      chat_id: params.telegramUserId,
      text: params.text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: { message_id?: number };
  } | null;
  if (!response.ok || payload?.ok !== true || !payload.result?.message_id) {
    throw new Error("telegram_send_failed");
  }
  return { messageId: BigInt(payload.result.message_id) };
}

function releaseSummaryOrFallback(summary?: string[]) {
  const sanitized = sanitizeReleaseLines(summary?.length ? summary : [...RELEASE_NOTES.bullets]);
  return sanitized.some(hasMojibakeSignal)
    ? sanitizeReleaseLines([...RELEASE_NOTES.bullets])
    : sanitized;
}

export function hasMojibakeSignal(value: string) {
  return (
    /\uFFFD/.test(value) ||
    /пїЅ/i.test(value) ||
    /\?{4,}/.test(value) ||
    /[\u0080-\u009f]/.test(value)
  );
}
