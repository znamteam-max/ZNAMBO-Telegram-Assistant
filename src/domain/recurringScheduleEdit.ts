import { DateTime } from "luxon";

import { parseExplicitReminderIntervalMinutes } from "@/domain/untilDoneReminderText";
import { nextRecurringOccurrence } from "@/domain/recurringPolicySemantics";

export type RecurringSchedulePreset =
  | "daily"
  | "weekdays"
  | "weekly"
  | "every_2_weeks"
  | "monthly"
  | "yearly";

const PRESETS = new Set<RecurringSchedulePreset>([
  "daily",
  "weekdays",
  "weekly",
  "every_2_weeks",
  "monthly",
  "yearly",
]);

const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export function parseRecurringScheduleCallbackData(value: string) {
  const match = value.match(
    /^policy_schedule:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(daily|weekdays|weekly|every_2_weeks|monthly|yearly)$/i,
  );
  if (!match) return null;
  const preset = match[2].toLowerCase() as RecurringSchedulePreset;
  if (!PRESETS.has(preset)) return null;
  return { itemId: match[1], preset };
}

export function parseRecurringScheduleFollowup(text: string) {
  const normalized = text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const timeLocal = parseExplicitClock(normalized);
  const intervalMinutes = parseExplicitReminderIntervalMinutes(normalized);
  return {
    timeLocal,
    intervalMinutes,
  };
}

export function buildRecurringScheduleRule(params: {
  preset: RecurringSchedulePreset;
  timeLocal: string;
  now: Date;
  timezone: string;
}) {
  const local = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  if (params.preset === "daily") return `daily@${params.timeLocal}`;
  if (params.preset === "weekdays") return `weekdays@${params.timeLocal}`;
  if (params.preset === "weekly") {
    return `weekly:${WEEKDAY_CODES[local.weekday - 1]}@${params.timeLocal}`;
  }
  if (params.preset === "every_2_weeks") return `every_2_weeks@${params.timeLocal}`;
  if (params.preset === "monthly") return `monthly_days:${local.day}@${params.timeLocal}`;
  return `yearly:${local.toFormat("MM-dd")}@${params.timeLocal}`;
}

export function nextRecurringScheduleOccurrence(params: {
  rule: string;
  preset: RecurringSchedulePreset;
  timeLocal: string;
  after: Date;
  timezone: string;
}) {
  const canonical = nextRecurringOccurrence({
    rule: params.rule,
    after: params.after,
    timezone: params.timezone,
  });
  if (canonical) return canonical;

  const afterLocal = DateTime.fromJSDate(params.after, { zone: "utc" }).setZone(params.timezone);
  const [hour, minute] = params.timeLocal.split(":").map(Number);
  const atClock = (value: DateTime) =>
    value.startOf("day").set({ hour, minute, second: 0, millisecond: 0 });

  if (params.preset === "weekdays") {
    for (let offset = 0; offset <= 10; offset += 1) {
      const candidate = atClock(afterLocal.plus({ days: offset }));
      if (candidate.weekday <= 5 && candidate > afterLocal) return candidate.toUTC().toJSDate();
    }
    return null;
  }

  if (params.preset === "every_2_weeks") {
    let candidate = atClock(afterLocal);
    if (candidate <= afterLocal) candidate = candidate.plus({ weeks: 2 });
    return candidate.toUTC().toJSDate();
  }

  if (params.preset === "yearly") {
    let candidate = atClock(afterLocal);
    if (candidate <= afterLocal) candidate = candidate.plus({ years: 1 });
    return candidate.toUTC().toJSDate();
  }

  return null;
}

export function recurringSchedulePresetLabel(preset: RecurringSchedulePreset) {
  if (preset === "daily") return "каждый день";
  if (preset === "weekdays") return "по будням";
  if (preset === "weekly") return "раз в неделю";
  if (preset === "every_2_weeks") return "раз в 2 недели";
  if (preset === "monthly") return "раз в месяц";
  return "раз в год";
}

function parseExplicitClock(text: string) {
  const withPreposition = text.match(
    /(?:^|\s)(?:в|во|к)\s+(\d{1,2})(?:[.:](\d{2}))?\s*(утра|дня|вечера|ночи)?(?=$|\s|[,;.!?])/i,
  );
  const punctuated = text.match(/(?:^|\s)(\d{1,2})[.:](\d{2})(?=$|\s|[,;.!?])/i);
  const match = withPreposition ?? punctuated;
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const dayPart = match[3]?.toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;
  if ((dayPart === "вечера" || dayPart === "дня") && hour < 12) hour += 12;
  if ((dayPart === "утра" || dayPart === "ночи") && hour === 12) hour = 0;
  if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
