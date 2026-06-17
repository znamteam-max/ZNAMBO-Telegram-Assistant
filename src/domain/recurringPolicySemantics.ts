import { DateTime } from "luxon";

const WEEKDAY_CODES = {
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

const WEEKDAY_NUMBERS: Record<string, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};

export type RecurringPolicyIntent = {
  title: string;
  recurrenceRule: string;
  recurrenceKind: "daily" | "weekly" | "monthly_day_range";
  weekday: string | null;
  monthDays: number[];
  timeLocal: string | null;
  requireAck: boolean;
  ackAliases: string[];
  missingFields: Array<"reminderTime" | "title">;
};

export type ParsedCanonicalRecurrence =
  | {
      kind: "daily";
      timeLocal: string | null;
    }
  | {
      kind: "weekly";
      weekday: string;
      timeLocal: string | null;
    }
  | {
      kind: "monthly_day_range";
      monthDays: number[];
      timeLocal: string | null;
    }
  | {
      kind: "legacy";
      value: string;
    };

export function parseRecurringPolicyIntents(text: string): RecurringPolicyIntent[] {
  const intents: RecurringPolicyIntent[] = [];
  const daily = parseDailyIntent(text);
  const weekly = parseWeeklyIntent(text);
  const monthly = parseMonthlyIntent(text);
  if (daily) intents.push(daily);
  if (weekly) intents.push(weekly);
  if (monthly) intents.push(monthly);
  return intents;
}

export function parseCanonicalRecurrenceRule(rule: string | null): ParsedCanonicalRecurrence | null {
  if (!rule) return null;
  const daily = rule.match(/^daily(?:@(\d{2}:\d{2}))?$/i);
  if (daily) {
    return {
      kind: "daily",
      timeLocal: daily[1] ?? null,
    };
  }
  const weekly = rule.match(/^weekly:([A-Z]{2})(?:@(\d{2}:\d{2}))?$/i);
  if (weekly) {
    return {
      kind: "weekly",
      weekday: weekly[1].toUpperCase(),
      timeLocal: weekly[2] ?? null,
    };
  }
  const monthly = rule.match(/^monthly_days:([\d,]+)(?:@(\d{2}:\d{2}))?$/i);
  if (monthly) {
    return {
      kind: "monthly_day_range",
      monthDays: normalizeMonthDays(monthly[1].split(",").map(Number)),
      timeLocal: monthly[2] ?? null,
    };
  }
  return { kind: "legacy", value: rule };
}

export function withRecurringPolicyTime(rule: string, timeLocal: string) {
  const parsed = parseCanonicalRecurrenceRule(rule);
  if (!parsed || parsed.kind === "legacy") return rule;
  if (parsed.kind === "daily") return `daily@${timeLocal}`;
  if (parsed.kind === "weekly") return `weekly:${parsed.weekday}@${timeLocal}`;
  return `monthly_days:${parsed.monthDays.join(",")}@${timeLocal}`;
}

export function recurringRuleMissingField(rule: string | null) {
  const parsed = parseCanonicalRecurrenceRule(rule);
  if (!parsed || parsed.kind === "legacy") return null;
  return parsed.timeLocal ? null : "reminderTime";
}

export function canonicalRecurringRuleNeedsTime(rule: string | null) {
  return recurringRuleMissingField(rule) === "reminderTime";
}

export function nextRecurringOccurrence(params: {
  rule: string | null;
  after: Date;
  timezone: string;
}) {
  const parsed = parseCanonicalRecurrenceRule(params.rule);
  if (!parsed || parsed.kind === "legacy") return null;
  if (!parsed.timeLocal) return null;
  const afterLocal = DateTime.fromJSDate(params.after, { zone: "utc" }).setZone(params.timezone);
  const [hour, minute] = parsed.timeLocal.split(":").map(Number);

  if (parsed.kind === "daily") {
    let candidate = afterLocal.startOf("day").set({ hour, minute, second: 0, millisecond: 0 });
    if (candidate <= afterLocal) candidate = candidate.plus({ days: 1 });
    return candidate.toUTC().toJSDate();
  }

  if (parsed.kind === "weekly") {
    const targetWeekday = WEEKDAY_NUMBERS[parsed.weekday];
    if (!targetWeekday) return null;
    let daysAhead = (targetWeekday - afterLocal.weekday + 7) % 7;
    let candidate = afterLocal
      .plus({ days: daysAhead })
      .startOf("day")
      .set({ hour, minute, second: 0, millisecond: 0 });
    if (candidate <= afterLocal) {
      daysAhead = daysAhead === 0 ? 7 : daysAhead + 7;
      candidate = afterLocal
        .plus({ days: daysAhead })
        .startOf("day")
        .set({ hour, minute, second: 0, millisecond: 0 });
    }
    return candidate.toUTC().toJSDate();
  }

  for (let offset = 0; offset <= 370; offset += 1) {
    const day = afterLocal.plus({ days: offset }).startOf("day");
    if (!parsed.monthDays.includes(day.day)) continue;
    const candidate = day.set({ hour, minute, second: 0, millisecond: 0 });
    if (candidate > afterLocal) return candidate.toUTC().toJSDate();
  }
  return null;
}

export function formatRecurringRuleHuman(rule: string | null) {
  const parsed = parseCanonicalRecurrenceRule(rule);
  if (!parsed || parsed.kind === "legacy") return null;
  if (parsed.kind === "daily") {
    return parsed.timeLocal ? `каждый день в ${parsed.timeLocal}` : "каждый день";
  }
  if (parsed.kind === "weekly") {
    const weekday = {
      MO: "по понедельникам",
      TU: "по вторникам",
      WE: "по средам",
      TH: "по четвергам",
      FR: "по пятницам",
      SA: "по субботам",
      SU: "по воскресеньям",
    }[parsed.weekday] ?? "каждую неделю";
    return parsed.timeLocal ? `${weekday} в ${parsed.timeLocal}` : weekday;
  }
  const dayText = contiguousRange(parsed.monthDays)
    ? `${parsed.monthDays[0]}–${parsed.monthDays.at(-1)} числа каждого месяца`
    : `${parsed.monthDays.join(", ")} числа каждого месяца`;
  return parsed.timeLocal ? `${dayText} в ${parsed.timeLocal}` : dayText;
}

export function formatRecurringClarification(intents: RecurringPolicyIntent[]) {
  const lines = [
    intents.length > 1 ? `Я вижу ${intents.length} напоминания:` : "Понял напоминание:",
    "",
  ];
  intents.forEach((intent, index) => {
    if (intents.length > 1) lines.push(`${index + 1}. ❗ ${intent.title}`);
    else lines.push(`❗ ${intent.title}`);
    lines.push(`   🔔 ${formatRecurringRuleHuman(intent.recurrenceRule) ?? "по расписанию"}${intent.requireAck ? ", пока не выполню" : ""}`);
    if (intent.missingFields.includes("reminderTime")) {
      lines.push("   Не хватает времени напоминания.");
    }
    if (index < intents.length - 1) lines.push("");
  });
  lines.push(
    "",
    intents.length > 1
      ? "В какое время напоминать?"
      : intents[0]?.recurrenceKind === "weekly"
        ? "В какое время по этому дню недели напоминать?"
        : intents[0]?.recurrenceKind === "daily"
          ? "Во сколько каждый день напоминать?"
          : "В какое время напоминать в эти дни?",
  );
  return lines.join("\n");
}

export function isCadenceOnlyTitle(title: string) {
  const normalized = normalizeText(title);
  return (
    /^кажд(?:ый|ую|ые)(?=$|[^\p{L}])/u.test(normalized) ||
    /^15(?:\s*[,–-]\s*16).*(?:19)\s+чис/.test(normalized) ||
    /^с\s+15\s+по\s+19\s+чис/.test(normalized) ||
    /^пока\s+не\b/.test(normalized)
  );
}

export function parseStopCondition(text: string) {
  const normalized = normalizeText(text);
  if (
    !/(?:до\s+тех\s+пор,?\s*)?пока\s+(?:я\s+)?не\s+(?:выполню|сделаю|оплачу|перенесу|отмечу)/i.test(
      normalized,
    )
  ) {
    return null;
  }
  const aliases = ["done"];
  if (/перенесу/i.test(normalized)) aliases.push("rescheduled");
  return {
    stopCondition: "until_done" as const,
    ackAliases: aliases,
    humanText: /перенесу/i.test(normalized)
      ? "пока не выполню или не перенесу"
      : "пока не выполню",
  };
}

function parseWeeklyIntent(text: string): RecurringPolicyIntent | null {
  const match = text.match(
    /(?:кажд(?:ый|ую)\s+|по\s+)(понедельник(?:ам)?|вторник(?:ам)?|среду|средам|четверг(?:ам)?|пятницу|пятницам|субботу|субботам|воскресенье|воскресеньям)/i,
  );
  if (!match) return null;
  const weekday = WEEKDAY_CODES[normalizeText(match[1]) as keyof typeof WEEKDAY_CODES];
  if (!weekday) return null;
  const monthlyIndex = text.search(/кажд(?:ый|ую)\s+месяц/i);
  const source = text.slice(match.index ?? 0, monthlyIndex > (match.index ?? 0) ? monthlyIndex : undefined);
  const title = extractActionTitle(source, "mirror");
  const timeLocal = extractReminderTime(source);
  const stop = parseStopCondition(source);
  return {
    title: title ?? "Повторяющееся напоминание",
    recurrenceRule: `weekly:${weekday}${timeLocal ? `@${timeLocal}` : ""}`,
    recurrenceKind: "weekly",
    weekday,
    monthDays: [],
    timeLocal,
    requireAck: Boolean(stop),
    ackAliases: stop?.ackAliases ?? [],
    missingFields: [
      ...(title ? [] : (["title"] as const)),
      ...(timeLocal ? [] : (["reminderTime"] as const)),
    ],
  };
}

function parseDailyIntent(text: string): RecurringPolicyIntent | null {
  const match = text.match(/(?:кажд(?:ый|ое)\s+день|ежедневно|каждое\s+утро)/i);
  if (!match) return null;
  const source = text.slice(match.index ?? 0);
  const title = extractActionTitle(source, "mirror");
  const timeLocal = extractReminderTime(source);
  const stop = parseStopCondition(source);
  return {
    title: title ?? "Повторяющееся напоминание",
    recurrenceRule: `daily${timeLocal ? `@${timeLocal}` : ""}`,
    recurrenceKind: "daily",
    weekday: null,
    monthDays: [],
    timeLocal,
    requireAck: Boolean(stop),
    ackAliases: stop?.ackAliases ?? [],
    missingFields: [
      ...(title ? [] : (["title"] as const)),
      ...(timeLocal ? [] : (["reminderTime"] as const)),
    ],
  };
}

function parseMonthlyIntent(text: string): RecurringPolicyIntent | null {
  const monthly = text.match(/(?:кажд(?:ый|ую)\s+месяц|каждого\s+месяца)/i);
  if (!monthly) return null;
  const source = text.slice(monthlySourceStart(text, monthly.index ?? 0));
  const days = extractMonthDays(source);
  if (!days.length) return null;
  const title = extractActionTitle(source, "meter");
  const timeLocal = extractReminderTime(source);
  const stop = parseStopCondition(source);
  return {
    title: title ?? "Повторяющееся напоминание",
    recurrenceRule: `monthly_days:${days.join(",")}${timeLocal ? `@${timeLocal}` : ""}`,
    recurrenceKind: "monthly_day_range",
    weekday: null,
    monthDays: days,
    timeLocal,
    requireAck: Boolean(stop),
    ackAliases: stop?.ackAliases ?? [],
    missingFields: [
      ...(title ? [] : (["title"] as const)),
      ...(timeLocal ? [] : (["reminderTime"] as const)),
    ],
  };
}

function extractMonthDays(text: string) {
  const range = text.match(/с\s+(\d{1,2})(?:\s+числа?)?\s+по\s+(\d{1,2})(?:\s+числ[оа]?)?/i);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start >= 1 && end <= 31 && end >= start && end - start <= 15) {
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }
  }
  const list = text.match(
    /(\d{1,2})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*(?:,|и)\s*(\d{1,2})\s+чис/i,
  );
  return list ? normalizeMonthDays(list.slice(1).map(Number)) : [];
}

function extractReminderTime(text: string) {
  const match = text.match(/(?:^|[^\p{L}\d])(?:в|к)\s+(\d{1,2})(?:[.:](\d{2}))?(?=$|[^\d])/iu);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function extractActionTitle(text: string, hint: "mirror" | "meter") {
  const normalized = text.replace(/\s+/g, " ").trim();
  const subjunctive = normalized.match(
    /о\s+том,\s+чтобы\s+(?:я\s+)?(.+?)(?=[,.](?:\s|$)|\s+кажд(?:ый|ую)\b|\s+до\s+тех\s+пор|\s+пока\s+|$)/i,
  )?.[1];
  if (subjunctive) return cleanTitle(subjunctive);

  const explicit = normalized.match(
    /о\s+том,\s+что\s+нужно\s+(.+?)(?=[,.](?:\s|$)|\s+кажд(?:ый|ую)\b|\s+до\s+тех\s+пор|\s+пока\s+|$)/i,
  )?.[1];
  if (explicit) return cleanTitle(explicit);

  const verbPattern =
    hint === "mirror"
      ? /((?:проверить|решить|решать)(?:\s+и\s+решить)?\s+вопрос\s+(?:с|о\s+замене)\s+зеркал[^,.]*|проверить\s+зеркал[^,.]*|поменять\s+зеркал[^,.]*|заменить\s+зеркал[^,.]*)/i
      : /(внести\s+показани[яй]\s+сч[её]тчик[^,.]*|передать\s+показани[яй]\s+сч[её]тчик[^,.]*)/i;
  const matched = normalized.match(verbPattern)?.[1];
  if (matched) return cleanTitle(matched);

  const generic = normalized.match(
    /(?:напоминай|напомни|напоминать)(?:\s+мне)?(?:\s+о\s+том,?\s+что)?(?:\s+нужно)?\s+(.+?)(?=\s+пока\s+|\s+до\s+тех\s+пор|$)/i,
  )?.[1];
  const cleaned = generic ? cleanTitle(generic) : null;
  return cleaned && !isCadenceOnlyTitle(cleaned) ? cleaned : null;
}

function cleanTitle(value: string) {
  const cleaned = value
    .replace(/^(?:мне\s+)?/i, "")
    .replace(/^(?:то,\s+)?что\s+нужно\s+/i, "")
    .replace(/^нужно\s+/i, "")
    .replace(/\s+(?:кажд(?:ый|ую)\s+(?:понедельник|месяц)).*$/i, "")
    .replace(/\s+(?:до\s+тех\s+пор|пока\s+).*/i, "")
    .replace(/[.;,\s]+$/g, "")
    .trim();
  return normalizeRecurringReminderTitle(cleaned);
}

export function normalizeRecurringReminderTitle(value: string) {
  const cleaned = value
    .replace(/^о\s+том,\s+чтобы\s+(?:я\s+)?/i, "")
    .replace(/^о\s+том,\s+что\s+нужно\s+/i, "")
    .replace(/^(?:то,\s+)?что\s+нужно\s+/i, "")
    .replace(/^нужно\s+/i, "")
    .replace(/^решил(\s+вопрос)/i, "решить$1")
    .replace(/^решила(\s+вопрос)/i, "решить$1")
    .trim();
  return cleaned.replace(/^./u, (character) => character.toLocaleUpperCase("ru"));
}

function monthlySourceStart(text: string, monthlyIndex: number) {
  const before = text.slice(0, monthlyIndex);
  const rangeIndex = before.search(/с\s+\d{1,2}(?:\s+числа?)?\s+по\s+\d{1,2}/i);
  return rangeIndex >= 0 ? rangeIndex : monthlyIndex;
}

function normalizeMonthDays(days: number[]) {
  return [...new Set(days.filter((day) => Number.isInteger(day) && day >= 1 && day <= 31))].sort(
    (left, right) => left - right,
  );
}

function contiguousRange(days: number[]) {
  return days.length > 1 && days.every((day, index) => index === 0 || day === days[index - 1] + 1);
}

function normalizeText(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
