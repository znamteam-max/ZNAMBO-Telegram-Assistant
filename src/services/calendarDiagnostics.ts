import { getLatestCalendarSyncStateForUser } from "@/db/queries/googleCalendar";
import { getLatestAuditByAction } from "@/db/queries/audit";
import { getCalendarProvider, getEnv, isYandexCalendarConfigured } from "@/lib/env";
import {
  getYandexCalendarConfigDebug,
  runYandexCalendarTest,
  type YandexCalendarErrorClass,
} from "@/integrations/yandexCalendar";

const SAFE_ERROR_CLASSES = new Set<YandexCalendarErrorClass>([
  "auth_failed",
  "forbidden",
  "caldav_url_not_found",
  "network_error",
  "timeout",
  "parse_error",
  "write_failed",
  "read_back_failed",
  "delete_failed",
  "unknown",
]);

export async function getCalendarStatus(userId: string) {
  const provider = getCalendarProvider();
  const [latest, latestTestAudit] = await Promise.all([
    getLatestCalendarSyncStateForUser(userId),
    getLatestAuditByAction({ userId, action: "assistant.calendar_write_test" }),
  ]);
  const latestTest = latestTestAudit?.details as
    | { ok?: boolean; errorClass?: string | null }
    | undefined;
  const errorClass = safeCalendarErrorClass(latest?.sync.lastError);
  const testErrorClass = safeCalendarErrorClass(latestTest?.errorClass);
  return {
    provider,
    configured: provider === "yandex" ? isYandexCalendarConfigured() : provider !== "none",
    authorization:
      latestTest?.ok === true || latest?.sync.status === "synced"
        ? "ok"
        : testErrorClass === "auth_failed" ||
            testErrorClass === "forbidden" ||
            errorClass === "auth_failed" ||
            errorClass === "forbidden"
          ? "failed"
          : "unknown",
    write:
      latestTest?.ok === true || latest?.sync.status === "synced"
        ? "ok"
        : latestTest || latest?.sync.status === "error"
          ? "failed"
          : "unknown",
    lastWriteStatus: latestTest?.ok === true ? "verified" : latestTest ? "failed" : latest?.sync.status ?? "unknown",
    lastWriteErrorClass: testErrorClass ?? errorClass,
    lastSyncedAt: latest?.sync.syncedAt ?? null,
    lastItemTitle: latest?.item.title ?? null,
  };
}

export async function getCalendarDebug(userId: string) {
  const status = await getCalendarStatus(userId);
  const env = getEnv();
  return {
    ...status,
    ...(status.provider === "yandex"
      ? getYandexCalendarConfigDebug()
      : {
          hasUsername: false,
          hasPassword: false,
          hasBaseUrl: false,
          hasCalendarUrl: false,
          usesAppPassword: "unknown/manual",
        }),
    hasConfiguredProvider: env.CALENDAR_PROVIDER !== "none",
  };
}

export async function runCalendarWriteTest(userId: string) {
  const provider = getCalendarProvider();
  if (provider !== "yandex") {
    return {
      provider,
      ok: false,
      errorClass: "provider_not_supported",
      steps: {
        authorization: "not_run",
        create: "not_run",
        read: "not_run",
        delete: "not_run",
      },
      status: await getCalendarStatus(userId),
    };
  }
  const result = await runYandexCalendarTest();
  return { provider, ...result, status: await getCalendarStatus(userId) };
}

export function renderCalendarStatus(status: Awaited<ReturnType<typeof getCalendarStatus>>) {
  return [
    `Календарь: ${status.provider === "yandex" ? "Яндекс CalDAV" : status.provider}`,
    `Конфигурация: ${status.configured ? "есть" : "нет"}`,
    `Авторизация: ${status.authorization}`,
    `Запись: ${status.write}`,
    `Последняя синхронизация: ${status.lastSyncedAt?.toISOString() ?? "нет"}`,
    `Последняя ошибка: ${status.lastWriteErrorClass ?? "нет"}`,
  ].join("\n");
}

export function safeCalendarErrorClass(value: string | null | undefined) {
  if (!value) return null;
  return SAFE_ERROR_CLASSES.has(value as YandexCalendarErrorClass) ? value : "unknown";
}
