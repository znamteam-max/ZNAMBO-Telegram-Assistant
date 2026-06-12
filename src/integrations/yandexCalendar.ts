import { XMLParser } from "fast-xml-parser";
import { randomUUID } from "crypto";

import { getItemGoogleSyncState, markGoogleCalendarSync } from "@/db/queries/googleCalendar";
import type { PlannerItem } from "@/db/schema";
import { getEnv, isYandexCalendarConfigured, requireEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

type CalDavResponse = {
  href: string;
  displayName?: string;
  isCalendar: boolean;
};

export type YandexCalendarSyncResult =
  | { status: "disabled" | "skipped" }
  | { status: "synced"; externalId: string }
  | { status: "error"; errorClass: YandexCalendarErrorClass; safeMessage: string };

export type YandexCalendarErrorClass =
  | "auth_failed"
  | "forbidden"
  | "caldav_url_not_found"
  | "calendar_object_url_build_failed"
  | "network_error"
  | "timeout"
  | "parse_error"
  | "write_failed"
  | "read_back_failed"
  | "read_back_not_found"
  | "delete_failed"
  | "unknown";

export type CalendarUrlSource =
  | "YANDEX_CALDAV_CALENDAR_URL"
  | "YANDEX_CALENDAR_URL"
  | "discovery";

export type YandexCalendarTestResult = {
  ok: boolean;
  errorClass: YandexCalendarErrorClass | null;
  calendarObjectUrl: string | null;
  diagnostics: {
    calendarUrlSource: CalendarUrlSource;
    collectionUrlNormalized: boolean;
    createdObjectUrlPresent: boolean;
  } | null;
  steps: {
    authorization: "ok" | "failed" | "not_run";
    create: "ok" | "failed" | "not_run";
    read: "ok" | "failed" | "not_run";
    delete: "ok" | "failed" | "not_run";
  };
};

class YandexCalendarError extends Error {
  constructor(
    public readonly errorClass: YandexCalendarErrorClass,
    message: string,
  ) {
    super(message);
  }
}

type CalDavOperation = "authorization" | "create" | "read" | "delete";

type ResolvedCalendarCollection = {
  url: string;
  source: CalendarUrlSource;
  normalized: boolean;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
});

export async function syncPlannerItemToYandex(
  item: PlannerItem,
): Promise<YandexCalendarSyncResult> {
  if (!isYandexCalendarConfigured()) return { status: "disabled" };
  if (item.kind !== "event" && item.kind !== "training") return { status: "skipped" };
  if (!item.startAt) return { status: "skipped" };

  try {
    await markGoogleCalendarSync({
      item,
      status: "not_synced",
      provider: "yandex_calendar",
    });
    const existingSync = await getItemGoogleSyncState(item.id);
    const href =
      existingSync?.provider === "yandex_calendar" && existingSync.externalId
        ? existingSync.externalId
        : await buildNewEventHref(item);
    const ics = buildIcs(item, href);
    const headers: Record<string, string> = {
      "content-type": "text/calendar; charset=utf-8",
    };
    if (!existingSync?.externalId) headers["if-none-match"] = "*";

    await caldavRequest(href, {
      method: "PUT",
      headers,
      body: ics,
    });
    await readBackCalendarObject(href, `UID:${item.id}@znambo-telegram-assistant`);

    await markGoogleCalendarSync({
      item,
      externalId: href,
      status: "synced",
      provider: "yandex_calendar",
    });
    return { status: "synced", externalId: href };
  } catch (error) {
    const safe = classifyYandexCalendarError(error);
    await markGoogleCalendarSync({
      item,
      status: "error",
      lastError: safe.errorClass,
      provider: "yandex_calendar",
    });
    logger.warn("Yandex Calendar sync failed", {
      itemId: item.id,
      errorClass: safe.errorClass,
      safeMessage: safe.safeMessage,
    });
    return { status: "error", ...safe };
  }
}

export function getYandexCalendarConfigDebug() {
  const env = getEnv();
  const configuredCollection = getConfiguredCalendarCollection();
  return {
    calendarProvider: "yandex",
    configured: isYandexCalendarConfigured(),
    hasUsername: Boolean(env.YANDEX_CALDAV_USERNAME),
    hasPassword: Boolean(env.YANDEX_CALDAV_APP_PASSWORD),
    hasBaseUrl: Boolean(env.YANDEX_CALDAV_URL),
    hasCalendarUrl: Boolean(
      env.YANDEX_CALDAV_CALENDAR_URL || env.YANDEX_CALENDAR_URL?.startsWith("https://caldav."),
    ),
    calendarUrlSource: configuredCollection?.source ?? "discovery",
    collectionUrlNormalized: configuredCollection?.normalized ?? false,
    createdObjectUrlPresent: false,
    usesAppPassword: "unknown/manual",
  };
}

export async function runYandexCalendarTest(): Promise<YandexCalendarTestResult> {
  const steps: YandexCalendarTestResult["steps"] = {
    authorization: "not_run",
    create: "not_run",
    read: "not_run",
    delete: "not_run",
  };
  let calendarObjectUrl: string | null = null;
  let diagnostics: YandexCalendarTestResult["diagnostics"] = null;
  let testError: YandexCalendarErrorClass | null = null;
  try {
    const collection = await resolveCalendarCollection();
    const id = randomUUID();
    calendarObjectUrl = buildCalendarObjectUrl(collection.url, `znambo-calendar-test-${id}`);
    diagnostics = {
      calendarUrlSource: collection.source,
      collectionUrlNormalized: collection.normalized,
      createdObjectUrlPresent: Boolean(calendarObjectUrl),
    };
    await caldavRequest(collection.url, {
      method: "PROPFIND",
      headers: {
        "content-type": "application/xml; charset=utf-8",
        depth: "0",
      },
      body: calendarListBody(),
    }, "authorization");
    steps.authorization = "ok";
    const start = new Date(Date.now() + 10 * 60 * 1000);
    const end = new Date(start.getTime() + 5 * 60 * 1000);
    const ics = buildTestIcs(id, start, end);
    await caldavRequest(calendarObjectUrl, {
      method: "PUT",
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "if-none-match": "*",
      },
      body: ics,
    }, "create");
    steps.create = "ok";
    await readBackCalendarObject(calendarObjectUrl, `UID:${id}@znambo-telegram-assistant`);
    steps.read = "ok";
    await caldavRequest(calendarObjectUrl, { method: "DELETE" }, "delete");
    steps.delete = "ok";
    return { ok: true, errorClass: null, calendarObjectUrl, diagnostics, steps };
  } catch (error) {
    const safe = classifyYandexCalendarError(error);
    testError = safe.errorClass;
    if (steps.authorization === "not_run") steps.authorization = "failed";
    else if (steps.create === "not_run") steps.create = "failed";
    else if (steps.read === "not_run") steps.read = "failed";
    else if (steps.delete === "not_run") steps.delete = "failed";
    if (calendarObjectUrl && steps.create === "ok" && steps.delete !== "ok") {
      try {
        await caldavRequest(calendarObjectUrl, { method: "DELETE" }, "delete");
        steps.delete = "ok";
      } catch {
        steps.delete = "failed";
      }
    }
    return { ok: false, errorClass: testError, calendarObjectUrl, diagnostics, steps };
  }
}

export function classifyYandexCalendarError(error: unknown): {
  errorClass: YandexCalendarErrorClass;
  safeMessage: string;
} {
  if (error instanceof YandexCalendarError) {
    return { errorClass: error.errorClass, safeMessage: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout/i.test(message)) {
    return { errorClass: "timeout", safeMessage: "Calendar request timed out." };
  }
  if (/fetch|network|socket|econn|enotfound/i.test(message)) {
    return { errorClass: "network_error", safeMessage: "Calendar network request failed." };
  }
  if (/parse|xml/i.test(message)) {
    return { errorClass: "parse_error", safeMessage: "Calendar response could not be parsed." };
  }
  return { errorClass: "unknown", safeMessage: "Calendar request failed." };
}

async function buildNewEventHref(item: PlannerItem): Promise<string> {
  const collection = await resolveCalendarCollection();
  return buildCalendarObjectUrl(collection.url, item.id.replaceAll("-", ""));
}

async function resolveCalendarCollection(): Promise<ResolvedCalendarCollection> {
  const env = getEnv();
  const configured = getConfiguredCalendarCollection();
  if (configured) return configured;

  const root = ensureTrailingSlash(env.YANDEX_CALDAV_URL);
  const principal = await propfindHref(
    root,
    "0",
    currentUserPrincipalBody(),
    "current-user-principal",
  );
  const homeSet = await propfindHref(
    toAbsoluteCalDavUrl(principal),
    "0",
    calendarHomeSetBody(),
    "calendar-home-set",
  );
  const calendars = await propfindCalendars(toAbsoluteCalDavUrl(homeSet));
  const calendar = calendars.find((candidate) => candidate.isCalendar);
  if (!calendar) throw new Error("Yandex CalDAV calendar collection was not found.");
  const discovered = toAbsoluteCalDavUrl(calendar.href);
  return {
    url: ensureTrailingSlash(discovered),
    source: "discovery",
    normalized: true,
  };
}

export function buildCalendarObjectUrl(collectionUrl: string, uid: string): string {
  try {
    const normalizedCollection = ensureTrailingSlash(new URL(collectionUrl).toString());
    const safeUid = uid.trim().replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeUid) {
      throw new Error("Calendar object UID is empty after normalization.");
    }
    const objectUrl = new URL(`${safeUid}.ics`, normalizedCollection).toString();
    if (!objectUrl.endsWith(`${safeUid}.ics`)) {
      throw new Error("Calendar object URL does not contain the expected object name.");
    }
    return objectUrl;
  } catch {
    throw new YandexCalendarError(
      "calendar_object_url_build_failed",
      "Calendar object URL could not be built.",
    );
  }
}

async function propfindHref(
  url: string,
  depth: "0" | "1",
  body: string,
  propertyName: string,
): Promise<string> {
  const xml = await caldavText(url, { method: "PROPFIND", headers: { depth }, body });
  const responses = toArray(parser.parse(xml)?.multistatus?.response);
  for (const response of responses) {
    const prop = firstProp(response);
    const property = prop?.[propertyName];
    const href = typeof property === "object" && property ? property.href : null;
    if (typeof href === "string") return href;
  }
  throw new Error(`CalDAV property not found: ${propertyName}`);
}

async function propfindCalendars(url: string): Promise<CalDavResponse[]> {
  const xml = await caldavText(url, {
    method: "PROPFIND",
    headers: { depth: "1" },
    body: calendarListBody(),
  });
  const responses = toArray(parser.parse(xml)?.multistatus?.response);
  return responses.map((response) => {
    const prop = firstProp(response);
    const resourceTypes = Object.keys(prop?.resourcetype ?? {});
    return {
      href: String(response.href),
      displayName: typeof prop?.displayname === "string" ? prop.displayname : undefined,
      isCalendar: resourceTypes.includes("calendar"),
    };
  });
}

async function caldavText(url: string, init: RequestInit): Promise<string> {
  const response = await caldavRequest(url, {
    ...init,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      ...init.headers,
    },
  });
  return response.text();
}

async function caldavRequest(
  url: string,
  init: RequestInit,
  operation?: CalDavOperation,
): Promise<Response> {
  const username = requireEnv("YANDEX_CALDAV_USERNAME");
  const password = requireEnv("YANDEX_CALDAV_APP_PASSWORD");
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: {
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      ...init.headers,
    },
  });
  if (![200, 201, 204, 207].includes(response.status)) {
    const errorClass = classifyCalDavHttpError(response.status, operation, init.method);
    throw new YandexCalendarError(errorClass, `Yandex CalDAV request failed (${response.status}).`);
  }
  return response;
}

async function readBackCalendarObject(url: string, expectedUid: string) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await caldavRequest(url, { method: "GET" }, "read");
      const text = await response.text();
      if (!text.includes(expectedUid)) {
        throw new YandexCalendarError(
          "read_back_failed",
          "CalDAV read-back did not contain the expected UID.",
        );
      }
      return;
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof YandexCalendarError) ||
        error.errorClass !== "read_back_not_found" ||
        attempt === 2
      ) {
        throw error;
      }
      await delay(250 * (attempt + 1));
    }
  }
  throw lastError;
}

function buildIcs(item: PlannerItem, href: string): string {
  const now = formatIcsDate(new Date());
  const start = formatIcsDate(item.startAt ?? new Date());
  const end = formatIcsDate(
    item.endAt ?? new Date((item.startAt ?? new Date()).getTime() + 60 * 60 * 1000),
  );

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ZNAMBO Telegram Assistant//RU",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${item.id}@znambo-telegram-assistant`,
    `DTSTAMP:${now}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeIcsText(item.title)}`,
    item.description ? `DESCRIPTION:${escapeIcsText(item.description)}` : null,
    item.location ? `LOCATION:${escapeIcsText(item.location)}` : null,
    `URL:${escapeIcsText(href)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ]
    .filter(Boolean)
    .join("\r\n");
}

function buildTestIcs(id: string, start: Date, end: Date): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ZNAMBO Telegram Assistant//RU",
    "BEGIN:VEVENT",
    `UID:${id}@znambo-telegram-assistant`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    "SUMMARY:ZNAMBO CalDAV write verification",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function firstProp(response: Record<string, unknown> | undefined) {
  const propstat = toArray(
    response?.propstat as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  return propstat.find((entry) => entry?.prop)?.prop as
    | Record<string, Record<string, unknown> | string | undefined>
    | undefined;
}

function formatIcsDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}

function toAbsoluteCalDavUrl(href: string): string {
  return new URL(href, ensureTrailingSlash(getEnv().YANDEX_CALDAV_URL)).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function getConfiguredCalendarCollection(): ResolvedCalendarCollection | null {
  const env = getEnv();
  if (env.YANDEX_CALDAV_CALENDAR_URL) {
    return normalizeCollectionUrl(env.YANDEX_CALDAV_CALENDAR_URL, "YANDEX_CALDAV_CALENDAR_URL");
  }
  if (env.YANDEX_CALENDAR_URL?.startsWith("https://caldav.")) {
    return normalizeCollectionUrl(env.YANDEX_CALENDAR_URL, "YANDEX_CALENDAR_URL");
  }
  return null;
}

function normalizeCollectionUrl(value: string, source: CalendarUrlSource): ResolvedCalendarCollection {
  const parsed = new URL(value).toString();
  const url = ensureTrailingSlash(parsed);
  return { url, source, normalized: true };
}

function classifyCalDavHttpError(
  status: number,
  operation?: CalDavOperation,
  method?: string,
): YandexCalendarErrorClass {
  if (status === 401) return "auth_failed";
  if (status === 403) return "forbidden";
  if (status === 404) {
    if (operation === "read") return "read_back_not_found";
    if (operation === "delete") return "delete_failed";
    return "caldav_url_not_found";
  }
  if (operation === "delete" || method === "DELETE") return "delete_failed";
  if (operation === "read" || method === "GET") return "read_back_failed";
  return "write_failed";
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function currentUserPrincipalBody(): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-principal />
  </D:prop>
</D:propfind>`;
}

function calendarHomeSetBody(): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-home-set />
  </D:prop>
</D:propfind>`;
}

function calendarListBody(): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:displayname />
    <D:resourcetype />
  </D:prop>
</D:propfind>`;
}
