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
  const displayText = normalizeDisplayText(params.text);
  const normalized = normalize(displayText);
  if (!normalized) return null;
  const date = parseDateAnchor(normalized, params.timezone, params.now);
  if (!date) return null;
  const window = parseWindow({
    text: normalized,
    dateLabel: date.label,
    timezone: params.timezone,
    now: params.now,
  });
  const cadence = parseCadence(normalized);
  if (!window || !cadence) return null;
  if (!hasReminderIntent(normalized)) return null;
  const title = extractTitle(displayText, cadence.index + cadence.raw.length);
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
  if (endLocal <= startLocal) {
    if (window.allowOvernight) endLocal = endLocal.plus({ days: 1 });
    else return null;
  }

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

function parseWindow(params: {
  text: string;
  dateLabel: "сегодня" | "завтра" | "дата";
  timezone: string;
  now: Date;
}) {
  const explicit = params.text.match(
    /(?:^|\s)(?:утром\s+)?с\s+(\d{1,2})(?:[:.](\d{1,2}))?\s+до\s+(\d{1,2})(?:[:.](\d{1,2}))?(?:\s|$)/,
  );
  if (explicit) {
    const start = parseClock(explicit[1], explicit[2]);
    const end = parseClock(explicit[3], explicit[4]);
    if (!start || !end) return null;
    return { start, end, raw: explicit[0], index: explicit.index ?? 0, allowOvernight: true };
  }

  // "Сегодня каждый час до 17:00 напоминай про ..." means start now.
  // Keep end-only future-day commands strict rather than inventing a morning start.
  if (params.dateLabel !== "сегодня") return null;
  const endOnly = params.text.match(/(?:^|\s)до\s+(\d{1,2})(?:[:.](\d{1,2}))?(?:\s|$|[,;.!?])/);
  if (!endOnly) return null;
  const end = parseClock(endOnly[1], endOnly[2]);
  if (!end) return null;
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const startLocal = nowLocal.plus({ minutes: 1 }).set({ second: 0, millisecond: 0 });
  const start = { hour: startLocal.hour, minute: startLocal.minute };
  const endLocal = nowLocal.startOf("day").set({ hour: end.hour, minute: end.minute });
  if (endLocal <= startLocal) return null;
  return { start, end, raw: endOnly[0], index: endOnly.index ?? 0, allowOvernight: false };
}

function parseCadence(text: string) {
  const everyMinutes = text.match(/(?:^|\s)каждые\s+(\d{1,3})\s+мин(?:ут|уты|уту)?(?:\s|$)/);
  if (everyMinutes?.index !== undefined) {
    const minutes = Number(everyMinutes[1]);
    if (minutes >= 1 && minutes <= 240) {
      return { minutes, raw: everyMinutes[0], index: everyMinutes.index };
    }
  }
  const everyHours = text.match(/(?:^|\s)каждые\s+(\d{1,2})\s+час(?:а|ов)?(?:\s|$)/);
  if (everyHours?.index !== undefined) {
    const hours = Number(everyHours[1]);
    if (hours >= 1 && hours <= 24) {
      return { minutes: hours * 60, raw: everyHours[0], index: everyHours.index };
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
  const reminderTail = text.match(
    /(?:^|\s)(?:напомни|напоминай|напоминать|пинай|дергай)(?:\s+мне)?(?:\s+про)?\s+(.+)$/i,
  );
  if (reminderTail) {
    const reminderTitle = cleanupTitle(reminderTail[1]);
    if (reminderTitle) return toTitleCase(reminderTitle);
  }

  const tail = cleanupTitle(text.slice(afterCadenceIndex));
  if (tail) return toTitleCase(tail);
  return null;
}

function cleanupTitle(value: string) {
  return value
    .replace(/^[,.\s]+/g, "")
    .replace(/^(?:мне\s+)?(?:напомни|напоминай|напоминать|пинай|дергай)(?:\s+мне)?\s*/i, "")
    .replace(/^про\s+/i, "")
    .replace(/^(?:каждый\s+час|каждые\s+\d{1,3}\s+(?:мин(?:ут|уты|уту)?|час(?:а|ов)?))\s*/i, "")
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

function normalizeDisplayText(text: string) {
  return text.replace(/\s+/g, " ").trim();
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
