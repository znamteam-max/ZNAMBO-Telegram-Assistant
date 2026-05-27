import { DateTime } from "luxon";

import type { PlannerActionProposal } from "./schemas";

const weekdays: Record<string, number> = {
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

export function heuristicParseUserRequest(params: {
  text: string;
  timezone: string;
  now: Date;
}): PlannerActionProposal {
  const source = params.text.trim();
  const lower = source.toLowerCase();

  if (/что\s+(у\s+меня\s+)?(сегодня|завтра|на\s+неделе)/i.test(lower)) {
    return base({ intent: "answer", reply: "Покажу расписание через команду бота." });
  }

  const kind = /трен|z2|зал|станк/i.test(lower)
    ? "training"
    : /иде[яю]|замет/i.test(lower)
      ? "note"
      : /встреч|созвон|эфир|при[её]м|мероприят/i.test(lower)
        ? "event"
        : "task";

  const localDateTime = guessLocalDateTime(lower, params.timezone, params.now);
  const durationMinutes = kind === "training" ? 90 : kind === "event" ? 60 : null;
  const title = normalizeTitle(source, kind);

  return base({
    intent: "create_item",
    kind,
    title,
    startAtLocal: kind === "event" || kind === "training" ? localDateTime : null,
    dueAtLocal: kind === "task" ? localDateTime : null,
    durationMinutes,
    reminderPresets:
      kind === "event"
        ? ["24h", "day_morning", "1h", "followup"]
        : kind === "training"
          ? ["day_morning", "1h", "training_followup"]
          : kind === "task"
            ? ["custom", "task_overdue"]
            : [],
    reply: null,
    confidence: localDateTime || kind === "note" ? 0.65 : 0.45,
  });
}

function base(overrides: Partial<PlannerActionProposal>): PlannerActionProposal {
  return {
    intent: "create_item",
    kind: null,
    title: null,
    description: null,
    location: null,
    timezone: null,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: null,
    durationMinutes: null,
    priority: 3,
    reminderPresets: [],
    reply: null,
    requiresConfirmation: true,
    confidence: 0.5,
    memoryCandidates: [],
    preparationPrompt: null,
    disambiguationOptions: [],
    ...overrides,
  };
}

function guessLocalDateTime(lower: string, timezone: string, now: Date): string | null {
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  let date = nowLocal.startOf("day");

  if (/послезавтра/.test(lower)) {
    date = date.plus({ days: 2 });
  } else if (/завтра/.test(lower)) {
    date = date.plus({ days: 1 });
  } else {
    const weekdayMatch = Object.keys(weekdays).find((weekday) => lower.includes(weekday));
    if (weekdayMatch) {
      const target = weekdays[weekdayMatch];
      const delta = (target - nowLocal.weekday + 7) % 7 || 7;
      date = date.plus({ days: delta });
    }
  }

  const timeMatch = lower.match(/(?:\bв|\bк|после)\s*(\d{1,2})(?::(\d{2}))?/);
  if (
    !timeMatch &&
    !/завтра|послезавтра|понедельник|вторник|сред|четверг|пятниц|суббот|воскрес/.test(lower)
  ) {
    return null;
  }

  const hour = timeMatch ? Number(timeMatch[1]) : /вечер/.test(lower) ? 18 : 10;
  const minute = timeMatch?.[2] ? Number(timeMatch[2]) : 0;
  return date.set({ hour, minute, second: 0, millisecond: 0 }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function normalizeTitle(source: string, kind: string): string {
  const cleaned = source
    .replace(/^запиши\s+/i, "")
    .replace(/^напомни\s+/i, "")
    .replace(/^мне\s+/i, "")
    .trim();

  if (kind === "event") return cleaned.replace(/^встреч[ауы]?\s*/i, "Встреча ").trim();
  if (kind === "training") return cleaned.replace(/^тренировк[ауы]?\s*/i, "Тренировка ").trim();
  if (kind === "note") return cleaned.replace(/^иде[яю]:?\s*/i, "").trim();
  return cleaned;
}
