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
  if (options === DateTime.DATETIME_MED) return formatRuWeekdayDateTime(date, timezone);
  return utcDateToLocal(date, timezone).setLocale("ru").toLocaleString(options);
}

export function formatLocalDateRange(
  start: Date | null,
  end: Date | null,
  timezone: string,
): string {
  if (!start && !end) return "без времени";
  if (!start) return `до ${formatRuWeekdayDateTime(end, timezone)}`;
  return formatRuWeekdayDateRange(start, end, timezone);
}

const RU_WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function formatRuWeekdayDateTime(
  date: Date | null | undefined,
  timezone: string,
  options?: { includeYear?: boolean; timeOnly?: boolean },
) {
  if (!date) return "без времени";
  const local = utcDateToLocal(date, timezone);
  if (options?.timeOnly) return local.toFormat("HH:mm");
  return `${RU_WEEKDAYS[local.weekday - 1]}, ${local.toFormat(options?.includeYear ? "dd.LL.yyyy HH:mm" : "dd.LL HH:mm")}`;
}

export function formatRuWeekdayDateRange(
  start: Date | null | undefined,
  end: Date | null | undefined,
  timezone: string,
) {
  if (!start) return "без времени";
  const startLocal = utcDateToLocal(start, timezone);
  const prefix = `${RU_WEEKDAYS[startLocal.weekday - 1]}, ${startLocal.toFormat("dd.LL HH:mm")}`;
  if (!end) return prefix;
  const endLocal = utcDateToLocal(end, timezone);
  return startLocal.hasSame(endLocal, "day")
    ? `${prefix}–${endLocal.toFormat("HH:mm")}`
    : `${prefix} – ${formatRuWeekdayDateTime(end, timezone)}`;
}
