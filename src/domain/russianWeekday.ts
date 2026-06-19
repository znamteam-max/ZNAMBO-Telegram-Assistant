import { DateTime } from "luxon";

const WEEKDAYS: Array<{ weekday: number; pattern: RegExp }> = [
  { weekday: 1, pattern: /понедельник(?:а|у|ом|е)?/i },
  { weekday: 2, pattern: /вторник(?:а|у|ом|е)?/i },
  { weekday: 3, pattern: /сред(?:а|у|ы|е|ой)/i },
  { weekday: 4, pattern: /четверг(?:а|у|ом|е)?/i },
  { weekday: 5, pattern: /пятниц(?:а|у|ы|е|ей)/i },
  { weekday: 6, pattern: /суббот(?:а|у|ы|е|ой)/i },
  { weekday: 7, pattern: /воскресень(?:е|я|ю|ем)/i },
];

export type RussianWeekdayAppointment = {
  weekday: number;
  hour: number;
  minute: number;
  localDateTime: string;
};

const WEEKDAY_SCHEDULE_PREFIX =
  /^\s*(?:в|во|на)\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)\s+(?:к|на|в)\s+\d{1,2}(?:[.:]\d{1,2})?\s*[,;:]?\s*/iu;

export function stripRussianWeekdaySchedulePhrase(text: string) {
  const stripped = text.replace(WEEKDAY_SCHEDULE_PREFIX, "").trim();
  if (!stripped) return text.trim();
  return stripped.replace(/^./u, (character) => character.toLocaleUpperCase("ru"));
}

export function parseRussianWeekdayAppointment(params: {
  text: string;
  timezone: string;
  now: Date;
}): RussianWeekdayAppointment | null {
  const weekday = WEEKDAYS.find((entry) => entry.pattern.test(params.text))?.weekday;
  const clock = extractAppointmentClock(params.text);
  if (!weekday || !clock) return null;

  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const explicitNextWeek = /через\s+недел[юи]/i.test(params.text);
  const days = (weekday - nowLocal.weekday + 7) % 7;
  let candidate = nowLocal
    .plus({ days })
    .startOf("day")
    .set({ hour: clock.hour, minute: clock.minute });
  if (explicitNextWeek) candidate = candidate.plus({ days: 7 });
  else if (candidate <= nowLocal) candidate = candidate.plus({ days: 7 });

  return {
    weekday,
    ...clock,
    localDateTime: candidate.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
  };
}

function extractAppointmentClock(text: string) {
  const match = text.match(/(?:^|\s)(?:к|на|в)\s+(\d{1,2})(?:[.:](\d{1,2}))?(?=\s|[,.!?;]|$)/i);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}
