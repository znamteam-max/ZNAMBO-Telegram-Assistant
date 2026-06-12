import { DateTime } from "luxon";

import {
  countVisibleExternalCalendarEvents,
  getCalendarImportState,
  getExternalCalendarEventByObjectUrl,
  markMissingExternalEventsHidden,
  updateCalendarImportState,
  upsertExternalCalendarEvent,
} from "@/db/queries/externalCalendarEvents";
import { listCalendarSyncStatesForUser } from "@/db/queries/googleCalendar";
import { listVisibleActivePlanItems } from "@/db/queries/items";
import { listUsers } from "@/db/queries/users";
import {
  classifyYandexCalendarError,
  queryYandexCalendarWindow,
} from "@/integrations/yandexCalendar";
import { getCalendarProvider, isYandexCalendarConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";

export type YandexCalendarImportResult = {
  ok: boolean;
  created: number;
  updated: number;
  hidden: number;
  recurring: number;
  skippedLinked: number;
  possibleDuplicates: number;
  visible: number;
  errorClass: string | null;
  from: Date;
  to: Date;
};

export async function importYandexCalendarForUser(params: {
  userId: string;
  timezone: string;
  now?: Date;
  from?: Date;
  to?: Date;
}): Promise<YandexCalendarImportResult> {
  const now = params.now ?? new Date();
  const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(params.timezone);
  const from = params.from ?? local.minus({ days: 1 }).startOf("day").toUTC().toJSDate();
  const to = params.to ?? local.plus({ days: 30 }).endOf("day").toUTC().toJSDate();
  const empty = {
    created: 0,
    updated: 0,
    hidden: 0,
    recurring: 0,
    skippedLinked: 0,
    possibleDuplicates: 0,
    visible: 0,
    from,
    to,
  };

  if (getCalendarProvider() !== "yandex" || !isYandexCalendarConfigured()) {
    return { ok: false, ...empty, errorClass: "calendar_not_configured" };
  }

  try {
    const [events, syncStates, localItems] = await Promise.all([
      queryYandexCalendarWindow({ from, to, timezone: params.timezone }),
      listCalendarSyncStatesForUser(params.userId, 1000),
      listVisibleActivePlanItems(params.userId, 1000),
    ]);
    const linkedObjectUrls = new Set(
      syncStates
        .map(({ sync }) => sync.externalId)
        .filter((value): value is string => Boolean(value)),
    );
    const seenObjectUrls = new Set<string>();
    let created = 0;
    let updated = 0;
    let recurring = 0;
    let skippedLinked = 0;
    let possibleDuplicates = 0;

    for (const event of events) {
      seenObjectUrls.add(event.calendarObjectUrl);
      if (linkedObjectUrls.has(event.calendarObjectUrl)) {
        skippedLinked += 1;
        continue;
      }
      const previous = await getExternalCalendarEventByObjectUrl({
        userId: params.userId,
        calendarObjectUrl: event.calendarObjectUrl,
        recurrenceId: event.recurrenceId,
      });
      if (previous) updated += 1;
      else created += 1;
      if (event.isRecurring) recurring += 1;
      if (
        !previous &&
        localItems.some((item) => {
          const anchor = item.startAt ?? item.dueAt;
          return (
            anchor &&
            Math.abs(anchor.getTime() - event.startAt.getTime()) < 5 * 60 * 1000 &&
            normalizeTitle(item.title) === normalizeTitle(event.summary)
          );
        })
      ) {
        possibleDuplicates += 1;
      }
      await upsertExternalCalendarEvent({
        userId: params.userId,
        calendarObjectUrl: event.calendarObjectUrl,
        uid: event.uid,
        etag: event.etag,
        summary: event.summary,
        description: event.description,
        location: event.location,
        startAt: event.startAt,
        endAt: event.endAt,
        timezone: event.timezone,
        isRecurring: event.isRecurring,
        recurrenceRule: event.recurrenceRule,
        recurrenceId: event.recurrenceId,
        exdates: event.exdates,
        lastSeenAt: now,
        metadata: {
          possibleDuplicate: !previous && possibleDuplicates > 0,
          importedAt: now.toISOString(),
        },
      });
    }
    const hidden = await markMissingExternalEventsHidden({
      userId: params.userId,
      from,
      to,
      seenObjectUrls: [...seenObjectUrls],
    });
    const visible = await countVisibleExternalCalendarEvents(params.userId);
    await updateCalendarImportState({
      userId: params.userId,
      importedEventsCount: created + updated,
      recurringEventsCount: recurring,
      externalEventsVisible: visible,
      possibleDuplicates,
      lastImportErrorClass: null,
      metadata: { from: from.toISOString(), to: to.toISOString(), skippedLinked },
    });
    return {
      ok: true,
      created,
      updated,
      hidden,
      recurring,
      skippedLinked,
      possibleDuplicates,
      visible,
      errorClass: null,
      from,
      to,
    };
  } catch (error) {
    const safe = classifyYandexCalendarError(error);
    await updateCalendarImportState({
      userId: params.userId,
      importedEventsCount: 0,
      recurringEventsCount: 0,
      externalEventsVisible: await countVisibleExternalCalendarEvents(params.userId).catch(() => 0),
      possibleDuplicates: 0,
      lastImportErrorClass: safe.errorClass,
      metadata: { from: from.toISOString(), to: to.toISOString() },
    }).catch(() => undefined);
    logger.warn("Yandex Calendar inbound import failed without blocking reminders", {
      userId: params.userId,
      errorClass: safe.errorClass,
      safeMessage: safe.safeMessage,
    });
    return { ok: false, ...empty, errorClass: safe.errorClass };
  }
}

export async function runDueYandexCalendarImports(params?: {
  now?: Date;
  minimumIntervalMinutes?: number;
  limit?: number;
}) {
  if (getCalendarProvider() !== "yandex" || !isYandexCalendarConfigured()) {
    return { checked: 0, imported: 0, failed: 0 };
  }
  const now = params?.now ?? new Date();
  const threshold = now.getTime() - (params?.minimumIntervalMinutes ?? 15) * 60 * 1000;
  const users = (await listUsers()).slice(0, params?.limit ?? 3);
  const result = { checked: 0, imported: 0, failed: 0 };
  for (const user of users) {
    const state = await getCalendarImportState(user.id);
    if (state?.lastImportAt && state.lastImportAt.getTime() > threshold) continue;
    result.checked += 1;
    const imported = await importYandexCalendarForUser({
      userId: user.id,
      timezone: user.timezone,
      now,
    });
    if (imported.ok) result.imported += 1;
    else result.failed += 1;
  }
  return result;
}

export async function getSafeCalendarImportStatus(userId: string) {
  const state = await getCalendarImportState(userId);
  return {
    lastImportAt: state?.lastImportAt?.toISOString() ?? null,
    importedEventsCount: state?.importedEventsCount ?? 0,
    recurringEventsCount: state?.recurringEventsCount ?? 0,
    externalEventsVisible: state?.externalEventsVisible ?? 0,
    possibleDuplicates: state?.possibleDuplicates ?? 0,
    lastImportErrorClass: state?.lastImportErrorClass ?? null,
  };
}

function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
