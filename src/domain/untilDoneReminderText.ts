import { DateTime } from "luxon";

export type UntilDoneReminderNormalization = {
  matched: true;
  intervalMinutes: number;
  requireAck: true;
  stopCondition: "until_done";
  catchUpMode: "one_immediate_then_resume";
  windowStart: string;
  windowEnd: "23:59";
  startsAt: Date;
  endsAt: Date;
  cadenceExplicit: boolean;
  endOfDayExplicit: boolean;
  untilDoneExplicit: boolean;
};

export function normalizeUntilDoneReminder(params: {
  text: string;
  timezone: string;
  now: Date;
}): UntilDoneReminderNormalization | null {
  const normalized = normalizeRu(params.text);
  const untilDoneExplicit =
    /пока\s+не\s+(?:сдела(?:ю|ем|но)|выполн(?:ю|им|ено)|отмеч(?:у|уся|ено)|подтверж(?:у|дено)|будет\s+готово)/i.test(
      normalized,
    ) || /\buntil\s+(?:i\s+)?(?:do|done|complete)/i.test(normalized);
  const endOfDayExplicit =
    /сегодня\s+целый\s+день|целый\s+день|весь\s+день|до\s+конца\s+дня|до\s+23[:.]?59/i.test(
      normalized,
    );
  const reminderIntent =
    /напом(?:ни|инай|инать)|долби|пинай|remind/i.test(normalized) ||
    untilDoneExplicit ||
    endOfDayExplicit;
  if (!reminderIntent || (!untilDoneExplicit && !endOfDayExplicit)) return null;

  const explicitInterval = parseExplicitIntervalMinutes(normalized);
  const intervalMinutes = explicitInterval ?? 60;
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  let starts = nowLocal.plus({ minutes: 1 }).set({ second: 0, millisecond: 0 });
  const remainder = starts.minute % 1;
  if (remainder) starts = starts.plus({ minutes: 1 - remainder });
  const ends = nowLocal.endOf("day").set({ hour: 23, minute: 59, second: 0, millisecond: 0 });
  if (starts > ends) return null;

  return {
    matched: true,
    intervalMinutes,
    requireAck: true,
    stopCondition: "until_done",
    catchUpMode: "one_immediate_then_resume",
    windowStart: starts.toFormat("HH:mm"),
    windowEnd: "23:59",
    startsAt: starts.toUTC().toJSDate(),
    endsAt: ends.toUTC().toJSDate(),
    cadenceExplicit: explicitInterval !== null,
    endOfDayExplicit,
    untilDoneExplicit,
  };
}

export function formatUntilDoneReminderSummary(params: {
  normalized: UntilDoneReminderNormalization;
  timezone: string;
}) {
  const first = DateTime.fromJSDate(params.normalized.startsAt, { zone: "utc" })
    .setZone(params.timezone)
    .toFormat("HH:mm");
  const cadence =
    params.normalized.intervalMinutes === 60
      ? "каждый час"
      : `каждые ${params.normalized.intervalMinutes} минут`;
  return [
    `Ок, буду напоминать ${cadence} до конца дня, пока не отметишь выполненным.`,
    `Первое напоминание: сегодня ${first}.`,
  ].join("\n");
}

function parseExplicitIntervalMinutes(text: string) {
  if (/кажд(?:ый|ые)\s+час|раз\s+в\s+час|hourly|every\s+hour/i.test(text)) return 60;
  if (/кажд(?:ые|ый)\s+(?:полчаса|30\s*мин)/i.test(text)) return 30;
  const minutes = text.match(/кажд(?:ые|ый)\s+(\d{1,3})\s*мин/i);
  if (minutes?.[1]) {
    const value = Number(minutes[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function normalizeRu(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
