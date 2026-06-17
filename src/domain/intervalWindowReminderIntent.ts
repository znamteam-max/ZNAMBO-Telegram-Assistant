import { createHash } from "node:crypto";

import { DateTime } from "luxon";

export type IntervalWindowReminderIntent = {
  intent: "create_interval_window_reminder";
  title: string;
  dateLocal: string;
  dateLabel: "сегодня" | "завтра" | "дата";
  windowStartLocal: string;
  windowEndLocal: string;
  startsAtLocalIso: string;
  endsAtLocalIso: string;
  intervalMinutes: number;
  timezone: string;
  requireAck: boolean;
  source: "standalone_interval_window_reminder";
  reason: "standalone_date_window_cadence_and_object";
  textHash: string;
};

const WEEKDAYS: Record<string, number> = {
  понедельник: 1,
  понедельнику: 1,
  вторник: 2,
  вторнику: 2,
  среду: 3,
  среда: 3,
  четверг: 4,
  четвергу: 4,
  пятницу: 5,
  пятница: 5,
  субботу: 6,
  суббота: 6,
  воскресенье: 7,
};

export function parseStandaloneIntervalWindowReminderIntent(params: {
  text: string;
  timezone: string;
  now: Date;
}): IntervalWindowReminderIntent | null {
  const normalized = normalize(params.text);
  if (!normalized) return null;
  const date = parseDateAnchor(normalized, params.timezone, params.now);
  if (!date) return null;
  const window = parseWindow(normalized);
  const cadence = parseCadence(normalized);
  if (!window || !cadence) return null;
  if (!hasReminderIntent(normalized)) return null;
  const title = extractTitle(normalized, cadence.index + cadence.raw.length);
  if (!title) return null;

  const startLocal = date.value.set({
    hour: window.start.hour,
    minute: window.start.minute,
    second: 0,
    millisecond: 0,
  });
  let endLocal = date.value.set({
    hour: window.end.hour,
    minute: window.end.minute,
    second: 0,
    millisecond: 0,
  });
  if (endLocal <= startLocal) endLocal = endLocal.plus({ days: 1 });

  return {
    intent: "create_interval_window_reminder",
    title,
    dateLocal: startLocal.toISODate() ?? startLocal.toFormat("yyyy-MM-dd"),
    dateLabel: date.label,
    windowStartLocal: startLocal.toFormat("HH:mm"),
    windowEndLocal: endLocal.toFormat("HH:mm"),
    startsAtLocalIso: startLocal.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    endsAtLocalIso: endLocal.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    intervalMinutes: cadence.minutes,
    timezone: params.timezone,
    requireAck: false,
    source: "standalone_interval_window_reminder",
    reason: "standalone_date_window_cadence_and_object",
    textHash: hashText(normalized),
  };
}

export function isStandaloneIntervalWindowReminderText(params: {
  text: string;
  timezone: string;
  now: Date;
}) {
  return Boolean(parseStandaloneIntervalWindowReminderIntent(params));
}

function parseDateAnchor(text: string, timezone: string, now: Date) {
  const localNow = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  if (/(?:^|\s)завтра(?:\s|$)/.test(text)) {
    return { value: localNow.plus({ days: 1 }).startOf("day"), label: "завтра" as const };
  }
  if (/(?:^|\s)сегодня(?:\s|$)/.test(text)) {
    return { value: localNow.startOf("day"), label: "сегодня" as const };
  }

  const date = text.match(/(?:^|\s)(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s|$)/);
  if (date) {
    const day = Number(date[1]);
    const month = monthNumber(date[2]);
    if (month && day >= 1 && day <= 31) {
      let candidate = localNow.set({ month, day }).startOf("day");
      if (candidate < localNow.startOf("day")) candidate = candidate.plus({ years: 1 });
      return { value: candidate, label: "дата" as const };
    }
  }

  const weekday = text.match(/(?:^|\s)(?:в|во)\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)(?:\s|$)/);
  if (weekday) {
    const target = WEEKDAYS[weekday[1]];
    if (!target) return null;
    let days = target - localNow.weekday;
    if (days <= 0) days += 7;
    return { value: localNow.plus({ days }).startOf("day"), label: "дата" as const };
  }

  return null;
}

function parseWindow(text: string) {
  const match = text.match(
    /(?:^|\s)(?:утром\s+)?с\s+(\d{1,2})(?:[:.](\d{1,2}))?\s+до\s+(\d{1,2})(?:[:.](\d{1,2}))?(?:\s|$)/,
  );
  if (!match) return null;
  const start = parseClock(match[1], match[2]);
  const end = parseClock(match[3], match[4]);
  if (!start || !end) return null;
  return { start, end, raw: match[0], index: match.index ?? 0 };
}

function parseCadence(text: string) {
  const everyMinutes = text.match(/(?:^|\s)каждые\s+(\d{1,3})\s+мин(?:ут|уты|уту)?(?:\s|$)/);
  if (everyMinutes?.index !== undefined) {
    const minutes = Number(everyMinutes[1]);
    if (minutes >= 1 && minutes <= 240) {
      return { minutes, raw: everyMinutes[0], index: everyMinutes.index };
    }
  }
  const everyHour = text.match(/(?:^|\s)каждый\s+час(?:\s|$)/);
  if (everyHour?.index !== undefined) {
    return { minutes: 60, raw: everyHour[0], index: everyHour.index };
  }
  return null;
}

function hasReminderIntent(text: string) {
  return /(?:^|\s)(?:напомни|напоминать|напоминай|пинай|дергай)(?:\s|$)/.test(text);
}

function extractTitle(text: string, afterCadenceIndex: number) {
  const tail = cleanupTitle(text.slice(afterCadenceIndex));
  if (tail) return toTitleCase(tail);

  const reminderTail = text.match(/(?:^|\s)(?:напомни|напоминай|пинай|дергай)(?:\s+мне)?(?:\s+про)?\s+(.+)$/);
  if (!reminderTail) return null;
  return toTitleCase(cleanupTitle(reminderTail[1]));
}

function cleanupTitle(value: string) {
  return value
    .replace(/^[,.\s]+/g, "")
    .replace(/^(?:мне\s+)?(?:напомни|напоминай|напоминать|пинай|дергай)(?:\s+мне)?\s*/i, "")
    .replace(/^про\s+/i, "")
    .replace(/^[,.\s]+/g, "")
    .trim();
}

function parseClock(hourValue: string, minuteValue?: string) {
  const hour = Number(hourValue);
  const minute = minuteValue === undefined ? 0 : Number(minuteValue.padEnd(2, "0").slice(0, 2));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function monthNumber(value: string) {
  return [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ].indexOf(value) + 1;
}

function normalize(text: string) {
  return text
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCase(value: string) {
  if (!value) return value;
  return value[0].toLocaleUpperCase("ru") + value.slice(1);
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
