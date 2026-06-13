import { and, count, desc, eq, gte, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";

import { getDb } from "../client";
import {
  calendarImportState,
  externalCalendarEvents,
  type ExternalCalendarEvent,
} from "../schema";

export type ExternalCalendarEventInput = {
  userId: string;
  provider?: string;
  calendarLabel?: string;
  calendarObjectUrl: string;
  uid: string;
  etag?: string | null;
  summary: string;
  description?: string | null;
  location?: string | null;
  startAt: Date;
  endAt?: Date | null;
  timezone: string;
  isRecurring?: boolean;
  recurrenceRule?: string | null;
  recurrenceId?: string;
  exdates?: string[];
  metadata?: Record<string, unknown>;
  lastSeenAt?: Date;
};

export async function upsertExternalCalendarEvent(input: ExternalCalendarEventInput) {
  const now = input.lastSeenAt ?? new Date();
  const recurrenceId = input.recurrenceId ?? "";
  const [row] = await getDb()
    .insert(externalCalendarEvents)
    .values({
      userId: input.userId,
      provider: input.provider ?? "yandex",
      calendarLabel: input.calendarLabel ?? "Личный",
      calendarObjectUrl: input.calendarObjectUrl,
      uid: input.uid,
      etag: input.etag,
      summary: input.summary,
      description: input.description,
      location: input.location,
      startAt: input.startAt,
      endAt: input.endAt,
      timezone: input.timezone,
      isRecurring: input.isRecurring ?? false,
      recurrenceRule: input.recurrenceRule,
      recurrenceId,
      exdates: input.exdates ?? [],
      lastSeenAt: now,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [
        externalCalendarEvents.userId,
        externalCalendarEvents.calendarObjectUrl,
        externalCalendarEvents.recurrenceId,
      ],
      set: {
        uid: input.uid,
        etag: input.etag,
        summary: input.summary,
        description: input.description,
        location: input.location,
        startAt: input.startAt,
        endAt: input.endAt,
        timezone: input.timezone,
        isRecurring: input.isRecurring ?? false,
        recurrenceRule: input.recurrenceRule,
        exdates: input.exdates ?? [],
        lastSeenAt: now,
        metadata: input.metadata ?? {},
        updatedAt: now,
      },
    })
    .returning();
  return row ?? null;
}

export async function listVisibleExternalCalendarEvents(params: {
  userId: string;
  from?: Date;
  to?: Date;
  limit?: number;
}) {
  const conditions = [
    eq(externalCalendarEvents.userId, params.userId),
    isNull(externalCalendarEvents.hiddenAt),
  ];
  if (params.from) conditions.push(gte(externalCalendarEvents.startAt, params.from));
  if (params.to) conditions.push(lte(externalCalendarEvents.startAt, params.to));
  return getDb()
    .select()
    .from(externalCalendarEvents)
    .where(and(...conditions))
    .orderBy(externalCalendarEvents.startAt)
    .limit(params.limit ?? 500);
}

export async function getExternalCalendarEventById(userId: string, id: string) {
  const [row] = await getDb()
    .select()
    .from(externalCalendarEvents)
    .where(and(eq(externalCalendarEvents.userId, userId), eq(externalCalendarEvents.id, id)))
    .limit(1);
  return row ?? null;
}

export async function hideExternalCalendarEvent(userId: string, id: string) {
  const now = new Date();
  const [row] = await getDb()
    .update(externalCalendarEvents)
    .set({
      hiddenAt: now,
      metadata: sql`${externalCalendarEvents.metadata} || '{"hiddenReason":"user_hidden"}'::jsonb`,
      updatedAt: now,
    })
    .where(and(eq(externalCalendarEvents.userId, userId), eq(externalCalendarEvents.id, id)))
    .returning();
  return row ?? null;
}

export async function hideExternalCalendarEventWithReason(params: {
  userId: string;
  id: string;
  reason: string;
}) {
  const now = new Date();
  const [row] = await getDb()
    .update(externalCalendarEvents)
    .set({
      hiddenAt: now,
      metadata: sql`${externalCalendarEvents.metadata} || ${JSON.stringify({
        hiddenReason: params.reason,
        hiddenAt: now.toISOString(),
      })}::jsonb`,
      updatedAt: now,
    })
    .where(
      and(eq(externalCalendarEvents.userId, params.userId), eq(externalCalendarEvents.id, params.id)),
    )
    .returning();
  return row ?? null;
}

export async function updateExternalCalendarEventMetadata(params: {
  userId: string;
  id: string;
  metadata: Record<string, unknown>;
}) {
  const [row] = await getDb()
    .update(externalCalendarEvents)
    .set({
      metadata: sql`${externalCalendarEvents.metadata} || ${JSON.stringify(params.metadata)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(externalCalendarEvents.userId, params.userId), eq(externalCalendarEvents.id, params.id)),
    )
    .returning();
  return row ?? null;
}

export async function listExternalCalendarEventsForCleanup(userId: string, limit = 1000) {
  return getDb()
    .select()
    .from(externalCalendarEvents)
    .where(eq(externalCalendarEvents.userId, userId))
    .orderBy(externalCalendarEvents.startAt)
    .limit(limit);
}

export async function unhideExternalCalendarEventsByReason(params: {
  userId: string;
  reason: string;
}) {
  const rows = await getDb()
    .update(externalCalendarEvents)
    .set({
      hiddenAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(externalCalendarEvents.userId, params.userId),
        sql`${externalCalendarEvents.metadata}->>'hiddenReason' = ${params.reason}`,
      ),
    )
    .returning({ id: externalCalendarEvents.id });
  return rows.length;
}

export async function deleteExternalCalendarEventCache(userId: string, id: string) {
  const [row] = await getDb()
    .delete(externalCalendarEvents)
    .where(and(eq(externalCalendarEvents.userId, userId), eq(externalCalendarEvents.id, id)))
    .returning();
  return row ?? null;
}

export async function markMissingExternalEventsHidden(params: {
  userId: string;
  from: Date;
  to: Date;
  seenObjectUrls: string[];
}) {
  const conditions = [
    eq(externalCalendarEvents.userId, params.userId),
    gte(externalCalendarEvents.startAt, params.from),
    lte(externalCalendarEvents.startAt, params.to),
  ];
  if (params.seenObjectUrls.length) {
    conditions.push(notInArray(externalCalendarEvents.calendarObjectUrl, params.seenObjectUrls));
  }
  const rows = await getDb()
    .update(externalCalendarEvents)
    .set({
      hiddenAt: new Date(),
      metadata: sql`${externalCalendarEvents.metadata} || '{"missingFromLastImport":true}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning({ id: externalCalendarEvents.id });
  return rows.length;
}

export async function getExternalCalendarEventByObjectUrl(params: {
  userId: string;
  calendarObjectUrl: string;
  recurrenceId?: string;
}) {
  const [row] = await getDb()
    .select()
    .from(externalCalendarEvents)
    .where(
      and(
        eq(externalCalendarEvents.userId, params.userId),
        eq(externalCalendarEvents.calendarObjectUrl, params.calendarObjectUrl),
        eq(externalCalendarEvents.recurrenceId, params.recurrenceId ?? ""),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function countVisibleExternalCalendarEvents(userId: string) {
  const [row] = await getDb()
    .select({ count: count() })
    .from(externalCalendarEvents)
    .where(and(eq(externalCalendarEvents.userId, userId), isNull(externalCalendarEvents.hiddenAt)));
  return Number(row?.count ?? 0);
}

export async function updateCalendarImportState(params: {
  userId: string;
  importedEventsCount: number;
  recurringEventsCount: number;
  externalEventsVisible: number;
  possibleDuplicates: number;
  lastImportErrorClass?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date();
  const [row] = await getDb()
    .insert(calendarImportState)
    .values({
      userId: params.userId,
      provider: "yandex",
      lastImportAt: now,
      importedEventsCount: params.importedEventsCount,
      recurringEventsCount: params.recurringEventsCount,
      externalEventsVisible: params.externalEventsVisible,
      possibleDuplicates: params.possibleDuplicates,
      lastImportErrorClass: params.lastImportErrorClass,
      metadata: params.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: calendarImportState.userId,
      set: {
        lastImportAt: now,
        importedEventsCount: params.importedEventsCount,
        recurringEventsCount: params.recurringEventsCount,
        externalEventsVisible: params.externalEventsVisible,
        possibleDuplicates: params.possibleDuplicates,
        lastImportErrorClass: params.lastImportErrorClass,
        metadata: sql`${calendarImportState.metadata} || ${JSON.stringify(params.metadata ?? {})}::jsonb`,
        updatedAt: now,
      },
    })
    .returning();
  return row ?? null;
}

export async function updateCalendarImportPreferences(params: {
  userId: string;
  preferences: Record<string, unknown>;
}) {
  const now = new Date();
  const metadata = { externalCalendarVisibility: params.preferences };
  const [row] = await getDb()
    .insert(calendarImportState)
    .values({
      userId: params.userId,
      provider: "yandex",
      metadata,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: calendarImportState.userId,
      set: {
        metadata: sql`${calendarImportState.metadata} || ${JSON.stringify(metadata)}::jsonb`,
        updatedAt: now,
      },
    })
    .returning();
  return row ?? null;
}

export async function getCalendarImportState(userId: string) {
  const [row] = await getDb()
    .select()
    .from(calendarImportState)
    .where(eq(calendarImportState.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function getLatestCalendarImportState() {
  const [row] = await getDb()
    .select()
    .from(calendarImportState)
    .orderBy(desc(calendarImportState.lastImportAt))
    .limit(1);
  return row ?? null;
}

export async function listExternalCalendarEventsByIds(userId: string, ids: string[]): Promise<ExternalCalendarEvent[]> {
  if (!ids.length) return [];
  return getDb()
    .select()
    .from(externalCalendarEvents)
    .where(and(eq(externalCalendarEvents.userId, userId), inArray(externalCalendarEvents.id, ids)));
}
