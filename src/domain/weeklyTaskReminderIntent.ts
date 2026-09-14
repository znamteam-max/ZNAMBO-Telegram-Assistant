import { parseExplicitReminderIntervalMinutes } from "@/domain/untilDoneReminderText";

const WEEKDAYS = {
  понедельник: "MO",
  понедельникам: "MO",
  вторник: "TU",
  вторникам: "TU",
  среду: "WE",
  средам: "WE",
  четверг: "TH",
  четвергам: "TH",
  пятницу: "FR",
  пятницам: "FR",
  субботу: "SA",
  субботам: "SA",
  воскресенье: "SU",
  воскресеньям: "SU",
} as const;

export type WeeklyTaskReminderIntent = {
  intent: "weekly_task_reminder";
  title: string;
  weekday: "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
  recurrenceRule: string;
  reminderStartLocal: string;
  reminderEndLocal: string;
  deadlineLocal: string;
  intervalMinutes: number;
  requireAck: boolean;
  timezone: string;
  source: "weekly_task_reminder_intent";
};

export function parseWeeklyTaskReminderIntent(params: {
  text: string;
  timezone: string;
}): WeeklyTaskReminderIntent | null {
  const normalized = normalize(params.text);
  if (!normalized) return null;

  const weekdayMatch = normalized.match(
    /(?:кажд(?:ую|ый)|по)\s+(понедельник(?:ам)?|вторник(?:ам)?|среду|средам|четверг(?:ам)?|пятницу|пятницам|субботу|субботам|воскресенье|воскресеньям)/i,
  );
  if (!weekdayMatch?.[1]) return null;
  const weekday = WEEKDAYS[weekdayMatch[1] as keyof typeof WEEKDAYS];
  if (!weekday) return null;

  const title = extractTaskTitle(params.text);
  if (!title) return null;

  const deadlineLocal = extractDeadlineClock(normalized);
  const reminderStartLocal = extractReminderStartClock(normalized);
  const reminderEndLocal = extractReminderEndClock(normalized);
  const intervalMinutes = parseExplicitReminderIntervalMinutes(normalized);
  const requireAck = /пока\s+(?:я\s+)?не\s+отмеч(?:у|у\s+задачу|у\s+ее|у\s+её|у\s+это|у\s+выполненн)/i.test(
    normalized,
  );

  // This deterministic route is intentionally strict. If any part of the compound
  // weekly-task contract is missing, leave the text to the normal clarification flow
  // rather than inventing a deadline, cadence or reminder window.
  if (!deadlineLocal || !reminderStartLocal || !reminderEndLocal || !intervalMinutes) return null;

  return {
    intent: "weekly_task_reminder",
    title,
    weekday,
    recurrenceRule: `weekly:${weekday}@${reminderStartLocal}`,
    reminderStartLocal,
    reminderEndLocal,
    deadlineLocal,
    intervalMinutes,
    requireAck,
    timezone: params.timezone,
    source: "weekly_task_reminder_intent",
  };
}

function extractTaskTitle(text: string) {
  const quoted = text.match(/(?:задач[ау]|задачу)\s*[«"]([^»"]+)[»"]/i)?.[1];
  if (quoted?.trim()) return quoted.trim();

  const generic = text.match(
    /(?:создавай\s+)?задач[ау]\s+(.+?)(?=(?:[.!?]\s*)?дедлайн(?:\s|$)|(?:[.!?]\s*)?начинай\s+напоминать(?:\s|$)|$)/i,
  )?.[1];
  if (!generic?.trim()) return null;
  return generic.replace(/[.;,\s]+$/g, "").trim();
}

function extractDeadlineClock(text: string) {
  const afterDeadline = text.match(
    /дедлайн[\s—–:,-]*(?:в\s+эту\s+\S+\s+)?(?:в|до)?\s*(\d{1,2})(?:[:.](\d{1,2}))?/i,
  );
  return afterDeadline ? formatClock(afterDeadline[1], afterDeadline[2]) : null;
}

function extractReminderStartClock(text: string) {
  const match = text.match(
    /(?:начинай\s+напоминать|начни\s+напоминать|напоминай)(?:\s+мне)?\s+(?:с|в)\s*(\d{1,2})(?:[:.](\d{1,2}))?/i,
  );
  return match ? formatClock(match[1], match[2]) : null;
}

function extractReminderEndClock(text: string) {
  const reminderIndex = text.search(/(?:начинай\s+напоминать|начни\s+напоминать|напоминай)/i);
  if (reminderIndex < 0) return null;
  const reminderClause = text.slice(reminderIndex);
  // Do not use JS \b before Cyrillic text: \b is ASCII-word-boundary based and
  // treats both a space and Cyrillic "д" as non-word characters.
  const match = reminderClause.match(/(?:^|\s)до\s*(\d{1,2})(?:[:.](\d{1,2}))?/i);
  return match ? formatClock(match[1], match[2]) : null;
}

function formatClock(hourValue: string, minuteValue?: string) {
  const hour = Number(hourValue);
  const minute = minuteValue === undefined ? 0 : Number(minuteValue.padEnd(2, "0").slice(0, 2));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalize(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
