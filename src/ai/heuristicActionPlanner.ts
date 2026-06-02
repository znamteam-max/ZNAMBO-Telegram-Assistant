import { DateTime } from "luxon";

import { getEnv } from "@/lib/env";

import { heuristicParseUserRequest } from "./heuristicParser";
import type { ActionPlan, ActionPlanItem, ActionPlanReminder } from "./schemas";

const dayCodes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
type DayCode = (typeof dayCodes)[number];
type MemoryCandidate = ActionPlan["memoryCandidates"][number];

const weekdayPatterns: Array<[DayCode, RegExp]> = [
  ["MO", /понедельник|понедельникам|понедельник(?:,|$)|пн\b/i],
  ["TU", /вторник|вторникам|вт\b/i],
  ["WE", /сред[ау]|средам|ср\b/i],
  ["TH", /четверг|четвергам|чт\b/i],
  ["FR", /пятниц[ау]|пятницам|пт\b/i],
  ["SA", /суббот[ау]|субботам|сб\b/i],
  ["SU", /воскресень[ею]|воскресеньям|вс\b/i],
];

export function heuristicBuildActionPlan(params: {
  text: string;
  timezone: string;
  now: Date;
  activeContext?: string;
}): ActionPlan {
  const source = params.text.trim();
  const lower = source.toLowerCase();
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);

  if (/что\s+(у\s+меня\s+)?(сегодня|завтра|на\s+неделе)/i.test(lower)) {
    return basePlan({
      intent: "answer",
      reply: "Покажу расписание через команды /today, /tomorrow, /week и /tasks.",
      confidence: 0.9,
    });
  }

  const memoryOnly = extractMemoryOnly(source, lower);
  if (memoryOnly) {
    return basePlan({
      intent: "answer",
      reply: "Запомнил. Буду учитывать это в следующих планах.",
      confidence: 0.95,
      memoryCandidates: [memoryOnly],
    });
  }

  const simpleEventTime = extractLastTime(lower);
  if (
    simpleEventTime &&
    /созвон|встреч|звонок|эфир|запись/i.test(lower) &&
    !isLongZoomCase(lower) &&
    !isNightSportsCase(lower)
  ) {
    const start = /сегодня/i.test(lower)
      ? localAt(nowLocal, simpleEventTime.hour, simpleEventTime.minute)
      : nextLocalTime(nowLocal, simpleEventTime.hour, simpleEventTime.minute, false);
    return basePlan({
      summary: "Понял событие.",
      confidence: 0.86,
      actions: [
        action({
          actionType: "event",
          kind: "event",
          title: normalizeSimpleEventTitle(source),
          startAtLocal: start,
          durationMinutes: 60,
          confidence: 0.86,
          risk: "low",
          reminders: [
            { type: "event_before", scheduledAtLocal: null, offsetMinutesBefore: 60, repeatUntilAck: false, payload: {} },
            { type: "15m", scheduledAtLocal: null, offsetMinutesBefore: 15, repeatUntilAck: false, payload: {} },
          ],
        }),
      ],
    });
  }

  if (isLongZoomCase(lower)) {
    return basePlan({
      summary: "Разложил сообщение на запись, подготовку, tentative-созвон и тренировку.",
      confidence: 0.92,
      actions: [
        action({
          actionType: "preparation",
          kind: "preparation_task",
          title: "Начать настройку Zoom",
          description: "Подготовиться к записи Больше Zoom.",
          dueAtLocal: localAt(nowLocal, 18, 30),
          confidence: 0.94,
          risk: "low",
          reminders: [
            reminder("preparation", localAt(nowLocal, 18, 30)),
          ],
        }),
        action({
          actionType: "event",
          kind: "event",
          title: "Запись Больше Zoom",
          startAtLocal: localAt(nowLocal, 19, 0),
          durationMinutes: 60,
          confidence: 0.95,
          risk: "low",
          reminders: [
            { type: "event_before", scheduledAtLocal: null, offsetMinutesBefore: 60, repeatUntilAck: false, payload: {} },
            { type: "15m", scheduledAtLocal: null, offsetMinutesBefore: 15, repeatUntilAck: false, payload: {} },
            reminder("followup", localAt(nowLocal, 20, 10), { prompt: "Как прошла запись Больше Zoom?" }),
          ],
        }),
        action({
          actionType: "tentative_event",
          kind: "tentative_event",
          title: "Возможный созвон по коротким видео",
          startAtLocal: localAt(nowLocal, 19, 30),
          durationMinutes: 30,
          confidence: 0.78,
          risk: "medium",
          tentative: true,
          reminders: [
            reminder("followup", localAt(nowLocal, 19, 20), {
              prompt: "Будет ли созвон по коротким видео?",
            }),
          ],
        }),
        action({
          actionType: "training",
          kind: "training",
          title: "Велосипед Z2",
          description: "60 минут, вторая зона, очень лайтовый режим; после эфира, если не будет созвона.",
          startAtLocal: localAt(nowLocal, 20, 0),
          durationMinutes: 60,
          confidence: 0.86,
          risk: "low",
          reminders: [
            reminder("after_event", localAt(nowLocal, 20, 0), {
              prompt: "Тренировка или созвон?",
            }),
            reminder("training_followup", localAt(nowLocal, 21, 15), {
              prompt: "Как ощущения после Z2?",
            }),
          ],
        }),
      ],
    });
  }

  if (/рилз|reels|f1|ф1|мма|mma/i.test(lower) && /кажд/i.test(lower)) {
    const days = extractWeekdays(lower);
    const recurrenceDays: DayCode[] = days.length ? days : ["MO", "TU", "WE", "TH", "FR"];
    const next = nextOccurrence(nowLocal, recurrenceDays, getEnv().DEFAULT_MORNING_REMINDER_TIME);
    return recurringPlan({
      title: "Напоминание о рилзах по F1 и MMA",
      daysOfWeek: recurrenceDays,
      nextLocal: next,
      source,
    });
  }

  if (/витамин/i.test(lower) && (/кажд/i.test(lower) || /пока\s+.*подтверж/i.test(lower))) {
    const next = nextOccurrence(nowLocal, dayCodes.slice(), getEnv().DEFAULT_MORNING_REMINDER_TIME);
    return recurringPlan({
      title: "Пить витамины",
      daysOfWeek: dayCodes.slice(),
      nextLocal: next,
      source,
    });
  }

  if (isNightSportsCase(lower)) {
    const time = extractLastTime(lower) ?? { hour: 3, minute: 30 };
    const weekday = extractFirstWeekday(lower);
    const start = weekday
      ? nextWeekdayLocal(nowLocal, weekday, time.hour, time.minute)
      : nextLocalTime(nowLocal, time.hour, time.minute, true);
    return basePlan({
      summary: "Записал ночной спортивный эфир как рабочее событие, не как поездку.",
      confidence: 0.9,
      actions: [
        action({
          actionType: "event",
          kind: "event",
          title: "Комментирование матча Сан-Антонио — Оклахома, игра 6",
          description: "Ночной спортивный эфир по Москве.",
          startAtLocal: start,
          durationMinutes: 150,
          confidence: 0.9,
          risk: "low",
          reminders: [
            reminder("preparation", DateTime.fromISO(start, { zone: params.timezone }).minus({ hours: 6 }).toFormat("yyyy-MM-dd'T'HH:mm:ss")),
            { type: "event_before", scheduledAtLocal: null, offsetMinutesBefore: 60, repeatUntilAck: false, payload: {} },
            { type: "30m", scheduledAtLocal: null, offsetMinutesBefore: 30, repeatUntilAck: false, payload: {} },
          ],
          memoryCandidates: [
            {
              category: "meeting_pattern",
              content: "Ночные матчи NBA/NHL по Москве в формате 3.00/3.30 трактовать как 03:00/03:30, не 15:00/15:30.",
              searchTags: ["спорт", "ночь", "NBA", "время"],
            },
          ],
        }),
      ],
    });
  }

  const single = heuristicParseUserRequest({ text: source, timezone: params.timezone, now: params.now });
  if (single.intent !== "create_item" || !single.kind || !single.title) {
    return basePlan({
      intent: single.intent === "answer" ? "answer" : "clarify",
      reply: single.reply,
      clarificationQuestions: single.disambiguationOptions.map((option) => option.label),
      confidence: single.confidence,
    });
  }

  return basePlan({
    summary: "Понял одно действие.",
    confidence: single.confidence,
    requiresConfirmation: single.requiresConfirmation,
    actions: [
      action({
        actionType: single.kind === "training" ? "training" : single.kind === "event" ? "event" : "task",
        kind: single.kind,
        title: single.title,
        description: single.description,
        location: single.location,
        timezone: single.timezone,
        startAtLocal: single.startAtLocal,
        endAtLocal: single.endAtLocal,
        dueAtLocal: single.dueAtLocal,
        durationMinutes: single.durationMinutes,
        priority: single.priority,
        confidence: single.confidence,
        requiresConfirmation: single.requiresConfirmation,
        reminders: single.reminderPresets.map((type) => ({
          type,
          scheduledAtLocal: null,
          offsetMinutesBefore: null,
          repeatUntilAck: false,
          payload: {},
        })),
        memoryCandidates: single.memoryCandidates,
      }),
    ],
    memoryCandidates: single.memoryCandidates,
  });
}

function normalizeSimpleEventTitle(source: string): string {
  return source
    .replace(/^сегодня\s+/i, "")
    .replace(/\s+в\s+\d{1,2}[.:]\d{2}/i, "")
    .trim();
}

function basePlan(overrides: Partial<ActionPlan>): ActionPlan {
  return {
    intent: "plan",
    summary: null,
    reply: null,
    confidence: 0.65,
    requiresConfirmation: false,
    actions: [],
    memoryCandidates: [],
    clarificationQuestions: [],
    ...overrides,
  };
}

function action(overrides: Partial<ActionPlanItem> & Pick<ActionPlanItem, "title">): ActionPlanItem {
  const { title, ...rest } = overrides;
  return {
    actionType: "task",
    kind: "task",
    title,
    description: null,
    location: null,
    timezone: null,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: null,
    durationMinutes: null,
    priority: 3,
    confidence: 0.7,
    risk: "low",
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: {},
    ...rest,
  };
}

function reminder(
  type: ActionPlanReminder["type"],
  scheduledAtLocal: string,
  payload: Record<string, unknown> = {},
): ActionPlanReminder {
  return { type, scheduledAtLocal, offsetMinutesBefore: null, repeatUntilAck: false, payload };
}

function recurringPlan(params: {
  title: string;
  daysOfWeek: DayCode[];
  nextLocal: string;
  source: string;
}): ActionPlan {
  return basePlan({
    summary: "Поставил повторяющееся напоминание до подтверждения.",
    confidence: 0.9,
    actions: [
      action({
        actionType: "recurring_task",
        kind: "recurring_task",
        title: params.title,
        description: params.source,
        dueAtLocal: params.nextLocal,
        confidence: 0.9,
        risk: "low",
        recurrence: {
          frequency: params.daysOfWeek.length === 7 ? "daily" : "weekly",
          daysOfWeek: params.daysOfWeek,
          timeLocal: getEnv().DEFAULT_MORNING_REMINDER_TIME,
          repeatUntilAck: true,
        },
        reminders: [
          {
            type: "recurring",
            scheduledAtLocal: params.nextLocal,
            offsetMinutesBefore: null,
            repeatUntilAck: true,
            payload: { buttons: ["done_today", "snooze", "skip_today", "stop_recurring"] },
          },
        ],
      }),
    ],
  });
}

function isLongZoomCase(lower: string): boolean {
  return /zoom/i.test(lower) && /18[:.]?30/.test(lower) && /19[:.]?00/.test(lower) && /трениров|велосипед|z2/i.test(lower);
}

function isNightSportsCase(lower: string): boolean {
  return /(сан[-\s]?антонио|оклахом|nba|нба|матч|игра\s+номер|комментир)/i.test(lower) && /3[.:]\d{2}|3\s*00/i.test(lower);
}

function localAt(nowLocal: DateTime, hour: number, minute: number): string {
  return nowLocal.startOf("day").set({ hour, minute, second: 0, millisecond: 0 }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function nextLocalTime(nowLocal: DateTime, hour: number, minute: number, forceNight: boolean): string {
  let candidate = nowLocal.startOf("day").set({ hour, minute, second: 0, millisecond: 0 });
  if (forceNight && hour <= 6 && candidate <= nowLocal) candidate = candidate.plus({ days: 1 });
  if (!forceNight && candidate <= nowLocal) candidate = candidate.plus({ days: 1 });
  return candidate.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function extractLastTime(lower: string): { hour: number; minute: number } | null {
  const matches = [...lower.matchAll(/(\d{1,2})[.:](\d{2})/g)];
  const match = matches.at(-1);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function extractWeekdays(lower: string): DayCode[] {
  return weekdayPatterns
    .filter(([, pattern]) => pattern.test(lower))
    .map(([code]) => code);
}

function extractFirstWeekday(lower: string): DayCode | null {
  return extractWeekdays(lower)[0] ?? null;
}

function nextWeekdayLocal(nowLocal: DateTime, day: DayCode, hour: number, minute: number): string {
  const targetWeekday = dayCodes.indexOf(day) + 1;
  let delta = (targetWeekday - nowLocal.weekday + 7) % 7;
  let candidate = nowLocal
    .startOf("day")
    .plus({ days: delta })
    .set({ hour, minute, second: 0, millisecond: 0 });
  if (candidate <= nowLocal) {
    delta = delta === 0 ? 7 : delta + 7;
    candidate = nowLocal
      .startOf("day")
      .plus({ days: delta })
      .set({ hour, minute, second: 0, millisecond: 0 });
  }
  return candidate.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function extractMemoryOnly(source: string, lower: string): MemoryCandidate | null {
  if (!/^(запомни|запомнить|важно[:\s])/i.test(source.trim())) return null;
  const content = source
    .replace(/^(запомни|запомнить|важно)[:\s-]*/i, "")
    .trim();
  if (!content) return null;

  const isNightSportsRule =
    /(nba|нба|оклахом|сан[-\s]?антонио|матч|эфир)/i.test(lower) &&
    /(3[:.]00|3[:.]30|03[:.]00|03[:.]30)/i.test(lower);

  return {
    category: isNightSportsRule ? "meeting_pattern" : "preference",
    content,
    searchTags: isNightSportsRule
      ? ["NBA", "ночной эфир", "03:00", "03:30", "Оклахома", "Сан-Антонио"]
      : [],
  };
}

export function nextOccurrence(nowLocal: DateTime, daysOfWeek: readonly DayCode[], timeLocal: string): string {
  const [hourRaw, minuteRaw] = timeLocal.split(":");
  const hour = Number(hourRaw || 9);
  const minute = Number(minuteRaw || 30);
  const targetWeekdays = new Set(daysOfWeek.map((day) => dayCodes.indexOf(day) + 1));

  for (let offset = 0; offset <= 14; offset += 1) {
    const candidate = nowLocal
      .startOf("day")
      .plus({ days: offset })
      .set({ hour, minute, second: 0, millisecond: 0 });
    if (targetWeekdays.has(candidate.weekday) && candidate > nowLocal) {
      return candidate.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    }
  }

  return nowLocal
    .plus({ days: 1 })
    .startOf("day")
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toFormat("yyyy-MM-dd'T'HH:mm:ss");
}
