import { DateTime } from "luxon";

import type { BotContext } from "@/bot/context";
import { itemMenuKeyboard } from "@/bot/keyboards";
import { replyAndRecord } from "@/bot/reply";
import { requireOwner } from "@/bot/context";
import {
  cancelPendingRemindersForPolicy,
} from "@/db/queries/reminders";
import {
  createReminderPolicyIfMissing,
  listReminderPoliciesForItem,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { formatRuWeekdayDateRange } from "@/domain/dateTime";
import { parseStopCondition } from "@/domain/recurringPolicySemantics";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";
import {
  clearActiveReminderPolicyEditSession,
  getActiveReminderPolicyEditSession,
  updateReminderPolicyEditSessionDraft,
  type ReminderPolicyEditDraft,
} from "@/services/reminderPolicyEditSessions";

export async function handleReminderPolicyEditTurn(
  ctx: BotContext,
  text: string,
  timezone: string,
) {
  const owner = requireOwner(ctx);
  const session = await getActiveReminderPolicyEditSession({ userId: owner.id }).catch(() => null);
  if (!session) return false;
  const input = parseReminderPolicyDraftInput(text);
  const stop = parseStopCondition(text);
  const fullCadence = parseReminderCadence({
    text,
    itemAnchor: session.item.startAt ?? session.item.dueAt,
    timezone: session.item.timezone || timezone,
    now: new Date(),
  });
  const draft: ReminderPolicyEditDraft = {
    ...session.draft,
    ...(input.intervalMinutes ? { intervalMinutes: input.intervalMinutes } : {}),
    ...(input.windowStart ? { windowStart: input.windowStart } : {}),
    ...(input.windowEnd !== undefined ? { windowEnd: input.windowEnd } : {}),
    ...(input.windowEndDayOffset !== undefined
      ? { windowEndDayOffset: input.windowEndDayOffset }
      : {}),
    ...(stop
      ? {
          stopCondition: stop.stopCondition,
          ackAliases: stop.ackAliases,
        }
      : {}),
  };
  if (fullCadence) {
    draft.intervalMinutes = fullCadence.intervalMinutes;
    draft.windowStart = fullCadence.windowStart;
    draft.windowEnd = fullCadence.windowEnd;
    draft.windowEndDayOffset = undefined;
  }
  if (!fullCadence && !stop && !input.intervalMinutes && input.windowEnd === undefined) {
    await replyAndRecord(
      ctx,
      `Я настраиваю напоминания для «${session.item.title}». Напиши интервал, границу или условие остановки.`,
    );
    return true;
  }
  await updateReminderPolicyEditSessionDraft({
    userId: owner.id,
    actionId: session.action.id,
    draft,
  });
  if (!draft.intervalMinutes) {
    await replyAndRecord(
      ctx,
      [
        "Ок, буду напоминать, пока не отметишь выполненным.",
        "Как часто напоминать?",
        "Можно написать: «каждый час» или «каждые 30 минут».",
      ].join("\n"),
    );
    return true;
  }
  if (draft.windowEnd === undefined) {
    await replyAndRecord(
      ctx,
      [
        `Ок, интервал: ${formatInterval(draft.intervalMinutes)}${draft.stopCondition ? ", пока не отметишь выполненным" : ""}.`,
        "До какого времени в день напоминать?",
        "Можно написать: «до 18:00», «до 21:00» или «без ограничения».",
      ].join("\n"),
    );
    return true;
  }
  const parsed = materializeReminderPolicyDraft({
    draft,
    itemAnchor: session.item.startAt ?? session.item.dueAt,
    timezone: session.item.timezone || timezone,
    now: new Date(),
  });
  if (!parsed) {
    await replyAndRecord(ctx, "Не смог определить окно напоминаний. Укажи время окончания, например «до 18:00».");
    return true;
  }
  const active = (await listReminderPoliciesForItem(owner.id, session.item.id, 30)).find(
    (policy) => policy.status === "active" && policy.policyType === "nag_until_ack",
  );
  const metadata = {
    activeWindowStart: parsed.windowStart,
    activeWindowEnd: parsed.windowEnd,
    stopCondition: draft.stopCondition ?? "until_done",
    stopOnItemComplete: true,
    ackAliases: draft.ackAliases ?? ["done"],
    mutationSource: "reminder_policy_edit_session",
  };
  const policy = active
    ? await updateReminderPolicy({
        userId: owner.id,
        policyId: active.id,
        title: session.item.title,
        policyType: "nag_until_ack",
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        nextFireAt: parsed.startsAt,
        intervalMinutes: parsed.intervalMinutes,
        requireAck: true,
        onWindowEnd: "keep_open",
        snoozedUntil: null,
        snoozeScope: null,
        metadata,
      })
    : await createReminderPolicyIfMissing({
        userId: owner.id,
        itemId: session.item.id,
        title: session.item.title,
        category: session.item.category ?? "reminder_edit",
        policyType: "nag_until_ack",
        timezone: session.item.timezone || timezone,
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        nextFireAt: parsed.startsAt,
        intervalMinutes: parsed.intervalMinutes,
        requireAck: true,
        onWindowEnd: "keep_open",
        idempotencyKey: `${session.item.id}:reminder-edit:${parsed.startsAt.toISOString()}:${parsed.intervalMinutes}`,
        metadata,
      });
  await cancelPendingRemindersForPolicy({ userId: owner.id, policyId: policy.id });
  await materializeNextPolicyReminder(policy, parsed.startsAt, { now: new Date() });
  await clearActiveReminderPolicyEditSession({ userId: owner.id, reason: "policy_applied" });
  await replyAndRecord(
    ctx,
    [
      "Готово:",
      session.item.title,
      "",
      `Напоминания: ❗ ${
        parsed.intervalMinutes === 60 ? "каждый час" : `каждые ${parsed.intervalMinutes} мин`
      } с ${parsed.windowStart}${
        parsed.windowEnd ? ` до ${parsed.windowEnd}` : ", без ограничения"
      }, пока не отмечу`,
      `Окно: ${
        parsed.endsAt
          ? formatRuWeekdayDateRange(
              parsed.startsAt,
              parsed.endsAt,
              session.item.timezone || timezone,
            )
          : `с ${parsed.windowStart}, без ограничения`
      }`,
    ].join("\n"),
    { reply_markup: itemMenuKeyboard(session.item.id) },
  );
  return true;
}

export function parseReminderPolicyDraftInput(text: string) {
  const normalized = text.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();
  const intervalMinutes =
    /кажд(?:ый|ые)\s+час|раз\s+в\s+час/i.test(normalized)
      ? 60
      : /кажд(?:ые|ый)\s+(?:полчаса|30\s*мин)/i.test(normalized)
        ? 30
        : Number(normalized.match(/кажд(?:ые|ый)\s+(\d{1,3})\s*мин/i)?.[1] ?? 0) || undefined;
  const endOfDay = normalized.match(/до\s+конца(?:\s+(сегодняшнего|завтрашнего))?\s+дня/i);
  const end = normalized.match(/до\s+(\d{1,2})(?:[.:](\d{2}))?/i);
  const start = normalized.match(/с\s+(\d{1,2})(?:[.:](\d{2}))?/i);
  const windowEnd = /без\s+огранич/i.test(normalized)
    ? null
    : endOfDay
      ? "23:59"
      : end
        ? clock(Number(end[1]), Number(end[2] ?? 0))
        : undefined;
  return {
    intervalMinutes,
    windowStart: start ? clock(Number(start[1]), Number(start[2] ?? 0)) : undefined,
    windowEnd,
    windowEndDayOffset: endOfDay
      ? endOfDay[1] === "завтрашнего"
        ? 1
        : endOfDay[1] === "сегодняшнего"
          ? 0
          : undefined
      : undefined,
  };
}

export function materializeReminderPolicyDraft(params: {
  draft: ReminderPolicyEditDraft;
  itemAnchor?: Date | null;
  timezone: string;
  now: Date;
}) {
  if (!params.draft.intervalMinutes || params.draft.windowEnd === undefined) return null;
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const anchorLocal = params.itemAnchor
    ? DateTime.fromJSDate(params.itemAnchor, { zone: "utc" }).setZone(params.timezone)
    : nowLocal;
  const startParts = (params.draft.windowStart ?? nowLocal.plus({ minutes: 1 }).toFormat("HH:mm"))
    .split(":")
    .map(Number);
  let starts = anchorLocal.startOf("day").set({
    hour: startParts[0],
    minute: startParts[1],
    second: 0,
    millisecond: 0,
  });
  if (starts <= nowLocal) {
    starts =
      params.itemAnchor && anchorLocal > nowLocal
        ? anchorLocal
        : nowLocal.plus({ minutes: 1 }).set({ second: 0, millisecond: 0 });
  }
  const endBase =
    typeof params.draft.windowEndDayOffset === "number"
      ? nowLocal.startOf("day").plus({ days: params.draft.windowEndDayOffset })
      : starts.startOf("day");
  const ends = params.draft.windowEnd
    ? endBase.set({
        hour: Number(params.draft.windowEnd.slice(0, 2)),
        minute: Number(params.draft.windowEnd.slice(3, 5)),
        second: 0,
        millisecond: 0,
      })
    : null;
  if (ends && ends <= starts) return null;
  return {
    intervalMinutes: params.draft.intervalMinutes,
    startsAt: starts.toUTC().toJSDate(),
    endsAt: ends?.toUTC().toJSDate() ?? null,
    windowStart: starts.toFormat("HH:mm"),
    windowEnd: params.draft.windowEnd,
  };
}

export function parseReminderCadence(params: {
  text: string;
  itemAnchor?: Date | null;
  timezone: string;
  now: Date;
}) {
  const normalized = params.text.toLowerCase().replace(/ё/g, "е");
  const cadenceOnly =
    /(кажд(?:ый|ые)\s+(?:час|полчаса|\d+\s*мин)|раз\s+в\s+час)/i.test(normalized) &&
    /с\s*\d{1,2}(?:[.:]\d{2})?\s*(?:утра)?\s+до\s*\d{1,2}(?:[.:]\d{2})?/i.test(normalized);
  if (!cadenceOnly) return null;
  const range = normalized.match(
    /с\s*(\d{1,2})(?:[.:](\d{2}))?\s*(?:утра)?\s+до\s*(\d{1,2})(?:[.:](\d{2}))?/i,
  );
  if (!range) return null;
  const intervalMinutes = /полчаса|30\s*мин/i.test(normalized) ? 30 : 60;
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const anchorLocal = params.itemAnchor
    ? DateTime.fromJSDate(params.itemAnchor, { zone: "utc" }).setZone(params.timezone)
    : nowLocal;
  let start = anchorLocal.startOf("day").set({
    hour: Number(range[1]),
    minute: Number(range[2] ?? 0),
  });
  if (start <= nowLocal) start = start.plus({ days: 1 });
  const adjustedEnd = start.set({ hour: Number(range[3]), minute: Number(range[4] ?? 0) });
  return {
    intervalMinutes,
    startsAt: start.toUTC().toJSDate(),
    endsAt: adjustedEnd.toUTC().toJSDate(),
    windowStart: start.toFormat("HH:mm"),
    windowEnd: adjustedEnd.toFormat("HH:mm"),
  };
}

function clock(hour: number, minute: number) {
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatInterval(minutes: number) {
  return minutes === 60 ? "каждый час" : `каждые ${minutes} минут`;
}
