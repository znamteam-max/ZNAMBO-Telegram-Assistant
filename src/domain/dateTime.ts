import { DateTime, type DateTimeFormatOptions } from "luxon";

export function assertValidZone(timezone: string): string {
  if (!DateTime.local().setZone(timezone).isValid) {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
  return timezone;
}

export function localIsoToUtcDate(localIso: string, timezone: string): Date {
  assertValidZone(timezone);
  const parsed = DateTime.fromISO(localIso, { zone: timezone });
  if (!parsed.isValid) {
    throw new Error(`Invalid local ISO datetime: ${localIso}`);
  }
  return parsed.toUTC().toJSDate();
}

export function utcDateToLocal(utcDate: Date, timezone: string): DateTime {
  assertValidZone(timezone);
  return DateTime.fromJSDate(utcDate, { zone: "utc" }).setZone(timezone);
}

export function startOfLocalDay(date: Date, timezone: string): Date {
  return utcDateToLocal(date, timezone).startOf("day").toUTC().toJSDate();
}

export function endOfLocalDay(date: Date, timezone: string): Date {
  return utcDateToLocal(date, timezone).endOf("day").toUTC().toJSDate();
}

export function addLocalDays(date: Date, timezone: string, days: number): Date {
  return utcDateToLocal(date, timezone).plus({ days }).toUTC().toJSDate();
}

export function formatLocalDateTime(
  date: Date | null | undefined,
  timezone: string,
  options: DateTimeFormatOptions = DateTime.DATETIME_MED,
): string {
  if (!date) return "без времени";
  return utcDateToLocal(date, timezone).setLocale("ru").toLocaleString(options);
}

export function formatLocalDateRange(
  start: Date | null,
  end: Date | null,
  timezone: string,
): string {
  if (!start && !end) return "без времени";
  if (!start) return `до ${formatLocalDateTime(end, timezone)}`;
  if (!end) return formatLocalDateTime(start, timezone);
  const startLocal = utcDateToLocal(start, timezone).setLocale("ru");
  const endLocal = utcDateToLocal(end, timezone).setLocale("ru");
  if (startLocal.hasSame(endLocal, "day")) {
    return `${startLocal.toLocaleString(DateTime.DATE_MED)}, ${startLocal.toFormat("HH:mm")}–${endLocal.toFormat("HH:mm")}`;
  }
  return `${startLocal.toLocaleString(DateTime.DATETIME_MED)} – ${endLocal.toLocaleString(DateTime.DATETIME_MED)}`;
}
