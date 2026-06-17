import { DateTime } from "luxon";

import type { PlannerItem, ReminderPolicy } from "@/db/schema";

import { normalizeUntilDoneReminder } from "./untilDoneReminderText";

export type TodayUntilDoneTaskNormalization = {
  matched: true;
  title: string;
  intervalMinutes: number;
  dueAtLocal: string;
  startsAtLocal: string;
  endsAtLocal: string;
  itemDueAtLocal: string;
  policyWindowEndLocal: string;
  endOfDayLocal: "23:59";
  startsAt: Date;
  endsAt: Date;
  metadata: {
    sourceNormalization: "today_until_done_v2190";
    normalization: "today_until_done";
    timeScope: "today";
    untilDone: true;
    endOfDayLocal: "23:59";
    itemDueAtLocal: string;
    policyWindowEndLocal: string;
    intervalMinutes: number;
    stopCondition: "until_done";
  };
};

const TODAY_PATTERN = /(?:\u0441\u0435\u0433\u043e\u0434\u043d\u044f|\bsegodnya\b|\btoday\b)/iu;
const UNTIL_DONE_PATTERN =
  /(?:\u0434\u043e\s+\u0442\u0435\u0445\s+\u043f\u043e\u0440[\s,]+\u043f\u043e\u043a\u0430|\u043f\u043e\u043a\u0430)[\s\p{L}\p{N},.-]{0,80}\u043d\u0435\s+(?:\u0441\u0434\u0435\u043b|\u0432\u044b\u043f\u043e\u043b\u043d|\u043e\u0442\u043c\u0435\u0447|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434|\u0437\u0430\u043a\u043e\u043d\u0447|\u0433\u043e\u0442\u043e\u0432)|(?:\bpoka\b|\bdo\s+teh\s+por\b)[\s\p{L}\p{N},.-]{0,80}\bne\s+(?:sdel|vypoln|otmech|podtverd|zakonch|gotov)/iu;
const REMINDER_LEAD_PATTERN =
  /^(?:\s*(?:\u043d\u0430\u043f\u043e\u043c\u043d\u0438|\u043d\u0430\u043f\u043e\u043c\u0438\u043d\u0430\u0439|\u043d\u0430\u043f\u043e\u043c\u0438\u043d\u0430\u0442\u044c|napomni|napominay|remind)\s+(?:\u043c\u043d\u0435\s+|me\s+)?)?(?:\u0441\u0435\u0433\u043e\u0434\u043d\u044f\s+|segodnya\s+|today\s+)?/iu;
const REMINDER_TAIL_PATTERN =
  /(?:[\s.!,;:]+(?:\u043d\u0430\u043f\u043e\u043c\u0438\u043d\u0430\u0439|\u043d\u0430\u043f\u043e\u043c\u043d\u0438|\u0434\u043e\s+\u0442\u0435\u0445\s+\u043f\u043e\u0440|\u043f\u043e\u043a\u0430|napominay|napomni|do\s+teh\s+por|poka)\b.*)$/iu;

export function normalizeTodayUntilDoneTask(params: {
  text: string;
  timezone: string;
  now: Date;
  title?: string | null;
}): TodayUntilDoneTaskNormalization | null {
  if (!TODAY_PATTERN.test(params.text) || !UNTIL_DONE_PATTERN.test(params.text)) return null;
  const untilDone =
    normalizeUntilDoneReminder({
      text: params.text,
      timezone: params.timezone,
      now: params.now,
    }) ?? buildFallbackUntilDone(params);
  if (!untilDone) return null;

  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const endLocal = nowLocal.set({ hour: 23, minute: 59, second: 0, millisecond: 0 });
  const startsLocal = DateTime.fromJSDate(untilDone.startsAt, { zone: "utc" }).setZone(
    params.timezone,
  );
  const title = cleanTodayUntilDoneTitle(params.title || extractTodayUntilDoneTitle(params.text));
  if (!title) return null;

  const dueAtLocal = endLocal.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const startsAtLocal = startsLocal.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const endsAtLocal = dueAtLocal;
  const itemDueAtLocal = endLocal.toISO({ suppressMilliseconds: true }) ?? dueAtLocal;
  const policyWindowEndLocal = itemDueAtLocal;

  return {
    matched: true,
    title,
    intervalMinutes: untilDone.intervalMinutes,
    dueAtLocal,
    startsAtLocal,
    endsAtLocal,
    itemDueAtLocal,
    policyWindowEndLocal,
    endOfDayLocal: "23:59",
    startsAt: untilDone.startsAt,
    endsAt: untilDone.endsAt,
    metadata: {
      sourceNormalization: "today_until_done_v2190",
      normalization: "today_until_done",
      timeScope: "today",
      untilDone: true,
      endOfDayLocal: "23:59",
      itemDueAtLocal,
      policyWindowEndLocal,
      intervalMinutes: untilDone.intervalMinutes,
      stopCondition: "until_done",
    },
  };
}

export function isTodayUntilDonePlannerItem(item?: PlannerItem | null) {
  return (
    item?.metadata?.timeScope === "today" ||
    item?.metadata?.normalization === "today_until_done" ||
    item?.metadata?.sourceNormalization === "today_until_done_v2190" ||
    item?.metadata?.untilDone === true
  );
}

export function isTodayUntilDoneReminderPolicy(policy?: ReminderPolicy | null) {
  if (!policy) return false;
  return (
    policy.metadata?.timeScope === "today" ||
    policy.metadata?.normalization === "today_until_done" ||
    policy.metadata?.sourceNormalization === "today_until_done_v2190" ||
    (policy.requireAck === true &&
      policy.metadata?.stopCondition === "until_done" &&
      policy.endsAt !== null &&
      localClock(policy.endsAt, policy.timezone) === "23:59")
  );
}

export function todayUntilDoneMetadataFromPolicy(policy: ReminderPolicy) {
  const endLocal =
    policy.endsAt &&
    DateTime.fromJSDate(policy.endsAt, { zone: "utc" })
      .setZone(policy.timezone)
      .toISO({ suppressMilliseconds: true });
  return {
    sourceNormalization: "today_until_done_v2190",
    normalization: "today_until_done",
    timeScope: "today",
    untilDone: true,
    endOfDayLocal: "23:59",
    itemDueAtLocal: endLocal ?? null,
    policyWindowEndLocal: endLocal ?? null,
    stopCondition: "until_done",
  };
}

function extractTodayUntilDoneTitle(text: string) {
  const todayMatch = text.match(TODAY_PATTERN);
  const start = todayMatch?.index === undefined ? 0 : todayMatch.index + todayMatch[0].length;
  return text.slice(start).replace(REMINDER_TAIL_PATTERN, "").trim();
}

function cleanTodayUntilDoneTitle(value: string | null | undefined) {
  return (value ?? "")
    .replace(REMINDER_LEAD_PATTERN, "")
    .replace(REMINDER_TAIL_PATTERN, "")
    .replace(/,\s*\u043d\u0430\s+\u043a\u0430\u043a\u043e\u0435\s+\u0447\u0438\u0441\u043b\u043e.*$/iu, "")
    .replace(/[.,;:!\s]+$/u, "")
    .trim();
}

function buildFallbackUntilDone(params: { text: string; timezone: string; now: Date }) {
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const starts = nowLocal.plus({ minutes: 1 }).set({ second: 0, millisecond: 0 });
  const ends = nowLocal.set({ hour: 23, minute: 59, second: 0, millisecond: 0 });
  if (starts > ends) return null;
  const intervalMinutes = /\b(?:every\s+30\s+min|kazhd\w*\s+30\s+min)/iu.test(params.text)
    ? 30
    : 60;
  return {
    matched: true as const,
    intervalMinutes,
    requireAck: true as const,
    stopCondition: "until_done" as const,
    catchUpMode: "one_immediate_then_resume" as const,
    windowStart: starts.toFormat("HH:mm"),
    windowEnd: "23:59" as const,
    startsAt: starts.toUTC().toJSDate(),
    endsAt: ends.toUTC().toJSDate(),
    cadenceExplicit: intervalMinutes !== 60,
    endOfDayExplicit: false,
    untilDoneExplicit: true,
  };
}

function localClock(value: Date, timezone: string) {
  return DateTime.fromJSDate(value, { zone: "utc" }).setZone(timezone).toFormat("HH:mm");
}
