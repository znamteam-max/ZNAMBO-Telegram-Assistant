import { XMLParser } from "fast-xml-parser";
import { randomUUID } from "crypto";
import { DateTime } from "luxon";

import { getItemCalendarSyncState, markGoogleCalendarSync } from "@/db/queries/googleCalendar";
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
  | { status: "synced"; externalId: string; durationMs: number }
  | {
      status: "pending_retry" | "failed";
      errorClass: YandexCalendarErrorClass;
      safeMessage: string;
      externalId: string | null;
      durationMs: number;
    };

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

type CalDavOperation = "authorization" | "create" | "read" | "delete" | "query";

type ResolvedCalendarCollection = {
  url: string;
  source: CalendarUrlSource;
  normalized: boolean;
};

export type YandexCalendarSyncOptions = {
  retryFirst?: boolean;
  totalTimeoutMs?: number;
};

export type YandexCalendarExternalEvent = {
  calendarObjectUrl: string;
  etag: string | null;
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  startAt: Date;
  endAt: Date | null;
  timezone: string;
  isRecurring: boolean;
  recurrenceRule: string | null;
  recurrenceId: string;
  exdates: string[];
  xZnamboTest?: boolean;
};

const YANDEX_PROVIDER = "yandex_calendar";

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
});

export async function syncPlannerItemToYandex(
  item: PlannerItem,
  options: YandexCalendarSyncOptions = {},
): Promise<YandexCalendarSyncResult> {
  if (!isYandexCalendarConfigured()) return { status: "disabled" };
  if (item.kind !== "event" && item.kind !== "training") return { status: "skipped" };
  if (!item.startAt) return { status: "skipped" };

  const startedAt = Date.now();
  const totalController = new AbortController();
  const totalTimeout = setTimeout(
    () => totalController.abort(new Error("Calendar total sync timeout")),
    options.totalTimeoutMs ?? getEnv().CALDAV_TOTAL_SYNC_TIMEOUT_MS,
  );
  let href: string | null = null;
  try {
    const existingSync = await getItemCalendarSyncState(item.id, YANDEX_PROVIDER);
    if (existingSync?.status === "disabled") return { status: "disabled" };
    href = existingSync?.externalId ?? await buildNewEventHref(item);
    await markGoogleCalendarSync({
      item,
      externalId: href,
      status: "syncing",
      lastError: null,
      provider: YANDEX_PROVIDER,
    });
    const expectedUid = `UID:${buildItemCalendarUid(item)}`;
    if (options.retryFirst) {
      try {
        await readCalendarObjectOnce(href, expectedUid, totalController.signal);
        const durationMs = Date.now() - startedAt;
        await markGoogleCalendarSync({
          item,
          externalId: href,
          status: "synced",
          lastError: null,
          durationMs,
          provider: YANDEX_PROVIDER,
        });
        return { status: "synced", externalId: href, durationMs };
      } catch (error) {
        if (classifyYandexCalendarError(error).errorClass !== "read_back_not_found") throw error;
      }
    }
    const ics = buildIcs(item, href);
    const headers: Record<string, string> = {
      "content-type": "text/calendar; charset=utf-8",
    };
    if (!existingSync?.externalId && !options.retryFirst) headers["if-none-match"] = "*";

    await caldavRequest(href, {
      method: "PUT",
      headers,
      body: ics,
      signal: totalController.signal,
    }, "create");
    await readBackCalendarObject(href, expectedUid, totalController.signal);

    const durationMs = Date.now() - startedAt;
    await markGoogleCalendarSync({
      item,
      externalId: href,
      status: "synced",
      lastError: null,
      durationMs,
      provider: YANDEX_PROVIDER,
    });
    return { status: "synced", externalId: href, durationMs };
  } catch (error) {
    const safe = classifyYandexCalendarError(error);
    const durationMs = Date.now() - startedAt;
    const status = isRetryableCalendarError(safe.errorClass) ? "pending_retry" : "failed";
    await markGoogleCalendarSync({
      item,
      externalId: href,
      status,
      lastError: safe.errorClass,
      durationMs,
      provider: YANDEX_PROVIDER,
    });
    logger.warn("Yandex Calendar sync failed", {
      itemId: item.id,
      errorClass: safe.errorClass,
      safeMessage: safe.safeMessage,
    });
    return { status, externalId: href, durationMs, ...safe };
  } finally {
    clearTimeout(totalTimeout);
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
    calendarObjectUrl = buildCalendarObjectUrl(collection.url, id);
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
    await readBackCalendarObject(calendarObjectUrl, `UID:${id}`);
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

export async function queryYandexCalendarWindow(params: {
  from: Date;
  to: Date;
  timezone?: string;
}): Promise<YandexCalendarExternalEvent[]> {
  const collection = await resolveCalendarCollection();
  const response = await caldavRequest(
    collection.url,
    {
      method: "REPORT",
      headers: {
        "content-type": "application/xml; charset=utf-8",
        depth: "1",
      },
      body: calendarQueryBody(params.from, params.to),
    },
    "query",
  );
  const xml = await response.text();
  return parseCalendarQueryResponse({
    xml,
    from: params.from,
    to: params.to,
    timezone: params.timezone ?? "Europe/Moscow",
  });
}

export async function deleteYandexCalendarObject(calendarObjectUrl: string) {
  await caldavRequest(calendarObjectUrl, { method: "DELETE" }, "delete");
}

export async function updateYandexCalendarObject(params: {
  calendarObjectUrl: string;
  uid: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  startAt: Date;
  endAt?: Date | null;
  etag?: string | null;
}) {
  const headers: Record<string, string> = {
    "content-type": "text/calendar; charset=utf-8",
  };
  if (params.etag) headers["if-match"] = params.etag;
  await caldavRequest(
    params.calendarObjectUrl,
    {
      method: "PUT",
      headers,
      body: buildExternalIcs(params),
    },
    "create",
  );
  await readBackCalendarObject(params.calendarObjectUrl, `UID:${params.uid}`);
}

export function parseCalendarQueryResponse(params: {
  xml: string;
  from: Date;
  to: Date;
  timezone: string;
}): YandexCalendarExternalEvent[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(params.xml) as Record<string, unknown>;
  } catch {
    throw new YandexCalendarError("parse_error", "Calendar query response could not be parsed.");
  }
  const multistatus = parsed.multistatus as Record<string, unknown> | undefined;
  const responses = toArray(
    multistatus?.response as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  const events: YandexCalendarExternalEvent[] = [];
  for (const response of responses) {
    const prop = firstProp(response);
    const calendarData = prop?.["calendar-data"];
    if (typeof calendarData !== "string") continue;
    const href = typeof response.href === "string" ? toAbsoluteCalDavUrl(response.href) : null;
    if (!href) continue;
    const etag = typeof prop?.getetag === "string" ? prop.getetag : null;
    for (const event of parseIcsEvents(calendarData, params.timezone)) {
      events.push(
        ...expandCalendarEvent({
          event: { ...event, calendarObjectUrl: href, etag },
          from: params.from,
          to: params.to,
        }),
      );
    }
  }
  return events;
}

export function parseIcsEvents(ics: string, fallbackTimezone = "Europe/Moscow") {
  const lines = unfoldIcsLines(ics);
  const results: Array<Omit<YandexCalendarExternalEvent, "calendarObjectUrl" | "etag">> = [];
  let current: Record<string, Array<{ params: Record<string, string>; value: string }>> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        const eventProperties = current;
        const uid = firstIcsValue(eventProperties, "UID");
        const start = parseIcsDateProperty(firstIcsProperty(eventProperties, "DTSTART"), fallbackTimezone);
        if (uid && start) {
          const end = parseIcsDateProperty(firstIcsProperty(eventProperties, "DTEND"), fallbackTimezone);
          const recurrenceRule = firstIcsValue(eventProperties, "RRULE");
          results.push({
            uid,
            summary: unescapeIcsText(firstIcsValue(eventProperties, "SUMMARY") || "Без названия"),
            description: nullableIcsText(firstIcsValue(eventProperties, "DESCRIPTION")),
            location: nullableIcsText(firstIcsValue(eventProperties, "LOCATION")),
            startAt: start.date,
            endAt: end?.date ?? null,
            timezone: start.timezone,
            isRecurring: Boolean(recurrenceRule),
            recurrenceRule: recurrenceRule || null,
            recurrenceId:
              parseIcsDateProperty(firstIcsProperty(eventProperties, "RECURRENCE-ID"), fallbackTimezone)
                ?.date.toISOString() ?? "",
            exdates: (eventProperties.EXDATE ?? [])
              .flatMap((property) => property.value.split(","))
              .map((value) =>
                parseIcsDateProperty(
                  { params: propertyParamsFor(eventProperties, "EXDATE"), value },
                  fallbackTimezone,
                )?.date.toISOString(),
              )
              .filter((value): value is string => Boolean(value)),
            xZnamboTest: /^true$/i.test(firstIcsValue(eventProperties, "X-ZNAMBO-TEST")),
          });
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const property = parseIcsLine(line);
    if (!property) continue;
    current[property.name] ??= [];
    current[property.name].push({ params: property.params, value: property.value });
  }
  return results;
}

function expandCalendarEvent(params: {
  event: YandexCalendarExternalEvent;
  from: Date;
  to: Date;
}) {
  const { event } = params;
  if (event.recurrenceId) {
    return isWithinWindow(event.startAt, params.from, params.to) ? [event] : [];
  }
  if (!event.recurrenceRule) {
    return isWithinWindow(event.startAt, params.from, params.to) ? [event] : [];
  }
  const rule = parseRrule(event.recurrenceRule);
  if (rule.FREQ !== "WEEKLY") {
    return isWithinWindow(event.startAt, params.from, params.to) ? [event] : [];
  }
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1));
  const until = rule.UNTIL ? parseIcsDateValue(rule.UNTIL, event.timezone)?.date ?? null : null;
  const count = Math.max(0, Number(rule.COUNT ?? 0));
  const weekdays = new Set(
    (rule.BYDAY ?? weekdayCode(event.startAt, event.timezone))
      .split(",")
      .map((value) => value.replace(/^[+-]?\d+/, "")),
  );
  const duration = event.endAt ? event.endAt.getTime() - event.startAt.getTime() : null;
  const exdates = new Set(event.exdates);
  const occurrences: YandexCalendarExternalEvent[] = [];
  let generated = 0;
  let cursor = DateTime.fromJSDate(event.startAt, { zone: "utc" }).setZone(event.timezone);
  const limit = DateTime.fromJSDate(params.to, { zone: "utc" }).setZone(event.timezone);
  while (cursor <= limit && generated < 1000) {
    const weeks = Math.floor(
      cursor.startOf("day").diff(
        DateTime.fromJSDate(event.startAt, { zone: "utc" }).setZone(event.timezone).startOf("week"),
        "weeks",
      ).weeks,
    );
    const occurrence = cursor.toUTC().toJSDate();
    const eligible =
      weeks % interval === 0 &&
      weekdays.has(weekdayCode(occurrence, event.timezone)) &&
      (!until || occurrence <= until);
    if (eligible) {
      generated += 1;
      if ((!count || generated <= count) && !exdates.has(occurrence.toISOString())) {
        if (isWithinWindow(occurrence, params.from, params.to)) {
          occurrences.push({
            ...event,
            startAt: occurrence,
            endAt: duration && duration > 0 ? new Date(occurrence.getTime() + duration) : null,
            recurrenceId: occurrence.toISOString(),
          });
        }
      }
    }
    if ((count && generated >= count) || (until && occurrence > until)) break;
    cursor = cursor.plus({ days: 1 });
  }
  return occurrences;
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
  return buildCalendarObjectUrl(collection.url, buildItemCalendarUid(item));
}

function buildItemCalendarUid(item: PlannerItem) {
  return item.id.replaceAll("-", "");
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
  const operationTimeoutMs =
    operation === "read"
      ? getEnv().CALDAV_READBACK_TIMEOUT_MS
      : getEnv().CALDAV_REQUEST_TIMEOUT_MS;
  const requestSignal = AbortSignal.timeout(operationTimeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, requestSignal])
    : requestSignal;
  const response = await fetch(url, {
    ...init,
    signal,
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

async function readBackCalendarObject(url: string, expectedUid: string, signal?: AbortSignal) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await readCalendarObjectOnce(url, expectedUid, signal);
      return;
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof YandexCalendarError) ||
        error.errorClass !== "read_back_not_found" ||
        attempt === 5
      ) {
        throw error;
      }
      await delay(Math.min(250 * 2 ** attempt, 2_000));
    }
  }
  throw lastError;
}

async function readCalendarObjectOnce(url: string, expectedUid: string, signal?: AbortSignal) {
  const response = await caldavRequest(
    url,
    { method: "GET", headers: { accept: "text/calendar" }, signal },
    "read",
  );
  const text = await response.text();
  if (!text.includes(expectedUid)) {
    throw new YandexCalendarError(
      "read_back_failed",
      "CalDAV read-back did not contain the expected UID.",
    );
  }
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
    `UID:${buildItemCalendarUid(item)}`,
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
    `UID:${id}`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    "SUMMARY:ZNAMBO CalDAV write verification",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function buildExternalIcs(params: {
  calendarObjectUrl: string;
  uid: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  startAt: Date;
  endAt?: Date | null;
}) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ZNAMBO Telegram Assistant//RU",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${params.uid}`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(params.startAt)}`,
    `DTEND:${formatIcsDate(params.endAt ?? new Date(params.startAt.getTime() + 60 * 60 * 1000))}`,
    `SUMMARY:${escapeIcsText(params.summary)}`,
    params.description ? `DESCRIPTION:${escapeIcsText(params.description)}` : null,
    params.location ? `LOCATION:${escapeIcsText(params.location)}` : null,
    `URL:${escapeIcsText(params.calendarObjectUrl)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ]
    .filter(Boolean)
    .join("\r\n");
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
  if (operation === "read" || operation === "query" || method === "GET" || method === "REPORT") {
    return "read_back_failed";
  }
  return "write_failed";
}

export function isRetryableCalendarError(errorClass: YandexCalendarErrorClass) {
  return ["timeout", "network_error", "read_back_not_found", "read_back_failed"].includes(
    errorClass,
  );
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

function calendarQueryBody(from: Date, to: Date): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag />
    <C:calendar-data />
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${formatIcsDate(from)}" end="${formatIcsDate(to)}" />
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
}

function unfoldIcsLines(ics: string) {
  return ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function parseIcsLine(line: string) {
  const separator = line.indexOf(":");
  if (separator <= 0) return null;
  const left = line.slice(0, separator);
  const value = line.slice(separator + 1);
  const [nameRaw, ...rawParams] = left.split(";");
  const params: Record<string, string> = {};
  for (const raw of rawParams) {
    const [key, ...parts] = raw.split("=");
    if (key && parts.length) params[key.toUpperCase()] = parts.join("=").replace(/^"|"$/g, "");
  }
  return { name: nameRaw.toUpperCase(), params, value };
}

function firstIcsProperty(
  event: Record<string, Array<{ params: Record<string, string>; value: string }>>,
  name: string,
) {
  return event[name]?.[0] ?? null;
}

function firstIcsValue(
  event: Record<string, Array<{ params: Record<string, string>; value: string }>>,
  name: string,
) {
  return firstIcsProperty(event, name)?.value ?? "";
}

function propertyParamsFor(
  event: Record<string, Array<{ params: Record<string, string>; value: string }>>,
  name: string,
) {
  return firstIcsProperty(event, name)?.params ?? {};
}

function parseIcsDateProperty(
  property: { params: Record<string, string>; value: string } | null,
  fallbackTimezone: string,
) {
  if (!property) return null;
  return parseIcsDateValue(property.value, property.params.TZID ?? fallbackTimezone);
}

function parseIcsDateValue(value: string, timezone: string) {
  let date: DateTime;
  if (/^\d{8}$/.test(value)) {
    date = DateTime.fromFormat(value, "yyyyLLdd", { zone: timezone }).startOf("day");
  } else if (/Z$/.test(value)) {
    date = DateTime.fromFormat(value, "yyyyLLdd'T'HHmmss'Z'", { zone: "utc" });
  } else {
    date = DateTime.fromFormat(value, "yyyyLLdd'T'HHmmss", { zone: timezone });
  }
  if (!date.isValid) return null;
  return { date: date.toUTC().toJSDate(), timezone };
}

function nullableIcsText(value: string) {
  const text = unescapeIcsText(value);
  return text || null;
}

function unescapeIcsText(value: string) {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseRrule(value: string) {
  return Object.fromEntries(
    value
      .split(";")
      .map((part) => part.split("="))
      .filter((entry) => entry.length === 2)
      .map(([key, ruleValue]) => [key.toUpperCase(), ruleValue.toUpperCase()]),
  ) as Record<string, string>;
}

function weekdayCode(date: Date, timezone: string) {
  return ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][
    DateTime.fromJSDate(date, { zone: "utc" }).setZone(timezone).weekday - 1
  ]!;
}

function isWithinWindow(value: Date, from: Date, to: Date) {
  return value >= from && value <= to;
}
