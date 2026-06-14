export type ParsedReminderWindow = {
  windowStart?: string;
  windowEnd?: string | null;
  windowEndDayOffset?: number;
  overnightCandidate?: boolean;
};

const CLOCK_WORDS: Record<string, number> = {
  ноль: 0,
  нуля: 0,
  один: 1,
  одного: 1,
  два: 2,
  двух: 2,
  три: 3,
  трех: 3,
  трёх: 3,
  четыре: 4,
  четырех: 4,
  четырёх: 4,
  пять: 5,
  пяти: 5,
  шесть: 6,
  шести: 6,
  семь: 7,
  семи: 7,
  восемь: 8,
  восьми: 8,
  девять: 9,
  девяти: 9,
  десять: 10,
  десяти: 10,
  одиннадцать: 11,
  одиннадцати: 11,
  двенадцать: 12,
  двенадцати: 12,
};

const CLOCK_TOKEN =
  "\\d{1,2}|ноль|нуля|один|одного|два|двух|три|трех|трёх|четыре|четырех|четырёх|пять|пяти|шесть|шести|семь|семи|восемь|восьми|девять|девяти|десять|десяти|одиннадцать|одиннадцати|двенадцать|двенадцати";

export function parseReminderWindowText(text: string): ParsedReminderWindow {
  const normalized = normalizeRu(text);
  const endOfDay = normalized.match(
    /до\s+конца(?:\s+(сегодняшнего|завтрашнего))?\s+дня/i,
  );
  const start = parseClockAfterKeyword(normalized, "с");
  const end = parseClockAfterKeyword(normalized, "до");
  const windowEnd = /без\s+огранич/i.test(normalized)
    ? null
    : endOfDay
      ? "23:59"
      : end?.clock;

  return {
    windowStart: start?.clock,
    windowEnd,
    windowEndDayOffset: endOfDay
      ? endOfDay[1] === "завтрашнего"
        ? 1
        : endOfDay[1] === "сегодняшнего"
          ? 0
          : undefined
      : undefined,
    overnightCandidate:
      Boolean(start?.clock && end?.clock) &&
      compareClock(end!.clock, start!.clock) <= 0 &&
      !endOfDay &&
      !end?.dayPart,
  };
}

export function parseClockAfterKeyword(text: string, keyword: "с" | "до") {
  const normalized = normalizeRu(text);
  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\d])${keyword}\\s+(${CLOCK_TOKEN})(?:[.:](\\d{2}))?\\s*(утра|вечера|дня|ночи)?(?=$|[^\\p{L}\\d])`,
    "iu",
  );
  const match = normalized.match(pattern);
  if (!match) return null;
  const hour = parseHourToken(match[1]);
  const minute = Number(match[2] ?? 0);
  const dayPart = match[3] as "утра" | "вечера" | "дня" | "ночи" | undefined;
  if (hour === null || minute > 59) return null;
  const adjustedHour = applyDayPart(hour, dayPart);
  if (adjustedHour === null) return null;
  const clock = formatClock(adjustedHour, minute);
  if (!clock) return null;
  return {
    clock,
    dayPart,
  };
}

export function formatClock(hour: number, minute: number) {
  if (hour > 23 || minute > 59 || hour < 0 || minute < 0) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseHourToken(value: string) {
  if (/^\d+$/.test(value)) {
    const hour = Number(value);
    return hour <= 23 ? hour : null;
  }
  return CLOCK_WORDS[value] ?? null;
}

function applyDayPart(hour: number, dayPart?: "утра" | "вечера" | "дня" | "ночи") {
  if (!dayPart) return hour <= 23 ? hour : null;
  if (dayPart === "вечера") return hour < 12 ? hour + 12 : hour;
  if (dayPart === "дня") return hour < 12 ? hour + 12 : hour;
  if (dayPart === "утра") return hour === 12 ? 0 : hour;
  if (dayPart === "ночи") return hour === 12 ? 0 : hour <= 5 ? hour : hour;
  return hour;
}

function compareClock(left: string, right: string) {
  const [leftHour, leftMinute] = left.split(":").map(Number);
  const [rightHour, rightMinute] = right.split(":").map(Number);
  return leftHour * 60 + leftMinute - (rightHour * 60 + rightMinute);
}

function normalizeRu(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
