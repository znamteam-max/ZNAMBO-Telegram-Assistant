import { DateTime } from "luxon";

export type BeforeEventReminderSpec = {
  fireAtLocal: string;
  minutesBefore: number;
  label: string;
};

export type BeforeEventReminderParseResult = {
  reminders: BeforeEventReminderSpec[];
  pastLabels: string[];
};

export function parseBeforeEventReminderSpecs(params: {
  text: string;
  eventStartLocal: DateTime;
  timezone: string;
  now: Date;
  allowAbsoluteTimes?: boolean;
  includePast?: boolean;
}): BeforeEventReminderParseResult {
  const normalized = normalizeReminderText(params.text);
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const candidates: Array<{ fireAt: DateTime; label: string }> = [];

  candidates.push(...parseRelativeDayReminders(normalized, params.eventStartLocal));
  candidates.push(...parseRelativeOffsetReminders(normalized, params.eventStartLocal));
  if (params.allowAbsoluteTimes) {
    candidates.push(...parseAbsoluteReminderTimes(normalized, params.eventStartLocal));
  }

  const unique = new Map<string, { fireAt: DateTime; label: string }>();
  for (const candidate of candidates) {
    if (!candidate.fireAt.isValid) continue;
    if (candidate.fireAt >= params.eventStartLocal) continue;
    unique.set(candidate.fireAt.toFormat("yyyy-MM-dd'T'HH:mm"), candidate);
  }

  const reminders: BeforeEventReminderSpec[] = [];
  const pastLabels: string[] = [];
  for (const candidate of [...unique.values()].sort(
    (left, right) => left.fireAt.toMillis() - right.fireAt.toMillis(),
  )) {
    const minutesBefore = Math.max(
      1,
      Math.round(params.eventStartLocal.diff(candidate.fireAt, "minutes").minutes),
    );
    if (candidate.fireAt <= nowLocal) {
      pastLabels.push(candidate.label);
      if (!params.includePast) continue;
    }
    reminders.push({
      fireAtLocal: candidate.fireAt.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      minutesBefore,
      label: candidate.label,
    });
  }

  return {
    reminders,
    pastLabels: [...new Set(pastLabels)],
  };
}

export function parseBeforeEventReminderSpecsForAnchor(params: {
  text: string;
  anchor: Date;
  timezone: string;
  now: Date;
  allowAbsoluteTimes?: boolean;
  includePast?: boolean;
}) {
  return parseBeforeEventReminderSpecs({
    text: params.text,
    eventStartLocal: DateTime.fromJSDate(params.anchor, { zone: "utc" }).setZone(params.timezone),
    timezone: params.timezone,
    now: params.now,
    allowAbsoluteTimes: params.allowAbsoluteTimes,
    includePast: params.includePast,
  });
}

export function detectBeforeEventReminderMode(text: string): "add" | "replace" | "ask" {
  const normalized = normalizeReminderText(text);
  if (/(?:замени|заменить|вместо|оставь\s+только)/i.test(normalized)) return "replace";
  if (/(?:добавь|добавить|еще|ещё)/i.test(normalized)) return "add";
  return "ask";
}

function parseRelativeDayReminders(text: string, eventStartLocal: DateTime) {
  const reminders: Array<{ fireAt: DateTime; label: string }> = [];
  for (const match of text.matchAll(
    /за\s+(?:один\s+)?день(?:\s+в\s+(\d{1,2})(?:[.:](\d{2}))?\s*(утра|вечера|дня|ночи)?)?/giu,
  )) {
    const rawHour = match[1] ? Number(match[1]) : 9;
    const minute = Number(match[2] ?? 0);
    const hour = normalizeHour(rawHour, match[3]);
    if (!isValidClock(hour, minute)) continue;
    const fireAt = eventStartLocal
      .minus({ days: 1 })
      .set({ hour, minute, second: 0, millisecond: 0 });
    reminders.push({
      fireAt,
      label: `за день в ${formatClock(hour, minute)}`,
    });
  }
  return reminders;
}

function parseRelativeOffsetReminders(text: string, eventStartLocal: DateTime) {
  const reminders: Array<{ fireAt: DateTime; label: string }> = [];
  const pattern =
    /за\s+(пол\s*часа|полчаса|полтора\s+часа|час|один|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|\d{1,3})\s*(час(?:а|ов)?|ч\.?|мин(?:ут(?:у|ы)?)?|м\.?)?/giu;
  for (const match of text.matchAll(pattern)) {
    if (/день/i.test(match[0])) continue;
    const minutes = parseOffsetMinutes(match[1], match[2]);
    if (!minutes) continue;
    const fireAt = eventStartLocal.minus({ minutes }).set({ second: 0, millisecond: 0 });
    reminders.push({
      fireAt,
      label: formatRelativeOffsetLabel(minutes),
    });
  }
  return reminders;
}

function parseAbsoluteReminderTimes(text: string, eventStartLocal: DateTime) {
  if (!/(^|\s)в\s*\d{1,2}(?:[.:]\d{2})?/iu.test(text)) return [];
  const reminders: Array<{ fireAt: DateTime; label: string }> = [];
  for (const match of text.matchAll(/\b(\d{1,2})(?:[.:](\d{2}))?\s*(утра|вечера|дня|ночи)?\b/giu)) {
    const tokenStart = match.index ?? 0;
    if (isRelativeQuantityToken(text, tokenStart, match[0].length)) continue;
    if (isDayRelativeClock(text, tokenStart)) continue;
    const hour = normalizeHour(Number(match[1]), match[3]);
    const minute = Number(match[2] ?? 0);
    if (!isValidClock(hour, minute)) continue;
    let fireAt = eventStartLocal.startOf("day").set({ hour, minute, second: 0, millisecond: 0 });
    if (fireAt >= eventStartLocal) fireAt = fireAt.minus({ days: 1 });
    reminders.push({
      fireAt,
      label: `в ${formatClock(hour, minute)}`,
    });
  }
  return reminders;
}

function parseOffsetMinutes(rawAmount: string, rawUnit?: string) {
  const amount = rawAmount.replace(/\s+/g, " ").trim();
  if (/^пол\s*часа$|^полчаса$/i.test(amount)) return 30;
  if (/^полтора\s+часа$/i.test(amount)) return 90;
  if (/^час$/i.test(amount)) return 60;
  const numeric = /^\d+$/.test(amount) ? Number(amount) : wordNumber(amount);
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric <= 0) return null;
  const unit = rawUnit?.toLocaleLowerCase("ru") ?? "";
  if (/^час|^ч/.test(unit)) return numeric * 60;
  if (/^мин|^м/.test(unit)) return numeric;
  return null;
}

function wordNumber(value: string) {
  return (
    {
      один: 1,
      одну: 1,
      два: 2,
      две: 2,
      три: 3,
      четыре: 4,
      пять: 5,
      шесть: 6,
      семь: 7,
      восемь: 8,
      девять: 9,
      десять: 10,
    } as Record<string, number | undefined>
  )[value.toLocaleLowerCase("ru")];
}

function normalizeHour(hour: number, marker?: string) {
  const normalizedMarker = marker?.toLocaleLowerCase("ru");
  if ((normalizedMarker === "вечера" || normalizedMarker === "дня") && hour >= 1 && hour <= 11) {
    return hour + 12;
  }
  if (normalizedMarker === "ночи" && hour === 12) return 0;
  return hour;
}

function isValidClock(hour: number, minute: number) {
  return (
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59
  );
}

function isRelativeQuantityToken(text: string, tokenStart: number, tokenLength: number) {
  const before = text.slice(Math.max(0, tokenStart - 5), tokenStart);
  const after = text.slice(tokenStart + tokenLength, tokenStart + tokenLength + 10);
  return /за\s*$/iu.test(before) || /^\s*(?:час|ч|мин|м)/iu.test(after);
}

function isDayRelativeClock(text: string, tokenStart: number) {
  const before = text.slice(Math.max(0, tokenStart - 20), tokenStart);
  return /за\s+(?:один\s+)?день\s+в\s*$/iu.test(before);
}

function formatRelativeOffsetLabel(minutes: number) {
  if (minutes === 30) return "за 30 минут";
  if (minutes === 60) return "за час";
  if (minutes === 90) return "за 1 час 30 минут";
  if (minutes === 120) return "за 2 часа";
  if (minutes === 1440) return "за день";
  if (minutes % 60 === 0) return `за ${minutes / 60} ${hourWord(minutes / 60)}`;
  return `за ${minutes} минут`;
}

function hourWord(hours: number) {
  const mod10 = hours % 10;
  const mod100 = hours % 100;
  if (mod10 === 1 && mod100 !== 11) return "час";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "часа";
  return "часов";
}

function formatClock(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeReminderText(text: string) {
  return text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
