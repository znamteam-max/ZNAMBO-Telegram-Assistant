import { XMLParser } from "fast-xml-parser";

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
  | { status: "error"; error: string };

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

    await markGoogleCalendarSync({
      item,
      externalId: href,
      status: "synced",
      provider: "yandex_calendar",
    });
    return { status: "synced", externalId: href };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markGoogleCalendarSync({
      item,
      status: "error",
      lastError: message,
      provider: "yandex_calendar",
    });
    logger.warn("Yandex Calendar sync failed", { itemId: item.id, error: message });
    return { status: "error", error: message };
  }
}

async function buildNewEventHref(item: PlannerItem): Promise<string> {
  const collectionUrl = await resolveCalendarCollectionUrl();
  return new URL(
    `${item.id.replaceAll("-", "")}.ics`,
    ensureTrailingSlash(collectionUrl),
  ).toString();
}

async function resolveCalendarCollectionUrl(): Promise<string> {
  const env = getEnv();
  if (env.YANDEX_CALDAV_CALENDAR_URL) return ensureTrailingSlash(env.YANDEX_CALDAV_CALENDAR_URL);
  if (env.YANDEX_CALENDAR_URL?.startsWith("https://caldav.")) {
    return ensureTrailingSlash(env.YANDEX_CALENDAR_URL);
  }

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
  return ensureTrailingSlash(toAbsoluteCalDavUrl(calendar.href));
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

async function caldavRequest(url: string, init: RequestInit): Promise<Response> {
  const username = requireEnv("YANDEX_CALDAV_USERNAME");
  const password = requireEnv("YANDEX_CALDAV_APP_PASSWORD");
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      ...init.headers,
    },
  });
  if (![200, 201, 204, 207].includes(response.status)) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Yandex CalDAV ${init.method ?? "GET"} failed: ${response.status} ${text.slice(0, 300)}`,
    );
  }
  return response;
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

function firstProp(response: Record<string, unknown> | undefined) {
  const propstat = toArray(response?.propstat as Record<string, unknown> | Record<string, unknown>[] | undefined);
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
