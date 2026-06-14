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
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { formatRuWeekdayDateRange } from "@/domain/dateTime";
import { formatHumanReminderPolicy } from "@/domain/reminderPolicyPresentation";
import {
  nextRecurringOccurrence,
  parseCanonicalRecurrenceRule,
  parseStopCondition,
  withRecurringPolicyTime,
} from "@/domain/recurringPolicySemantics";
import { parseReminderWindowText } from "@/domain/reminderTimeWindow";
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
  const activePolicies = await listReminderPoliciesForItem(owner.id, session.item.id, 30);
  const recurringApplied = await applyRecurringItemCadencePolicy({
    ctx,
    userId: owner.id,
    item: session.item,
    policies: activePolicies,
    draft,
    timezone: session.item.timezone || timezone,
    now: new Date(),
  });
  if (recurringApplied) return true;
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
  const active = activePolicies.find(
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
  const window = parseReminderWindowText(normalized);
  return {
    intervalMinutes,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    windowEndDayOffset: window.windowEndDayOffset,
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
  const input = parseReminderPolicyDraftInput(normalized);
  const window = parseReminderWindowText(normalized);
  const cadenceOnly =
    /(кажд(?:ый|ые)\s+(?:час|полчаса|\d+\s*мин)|раз\s+в\s+час)/i.test(normalized) &&
    Boolean(input.windowStart && input.windowEnd);
  if (!cadenceOnly) return null;
  if (window.overnightCandidate) return null;
  const intervalMinutes = input.intervalMinutes ?? (/полчаса|30\s*мин/i.test(normalized) ? 30 : 60);
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const anchorLocal = params.itemAnchor
    ? DateTime.fromJSDate(params.itemAnchor, { zone: "utc" }).setZone(params.timezone)
    : nowLocal;
  const [startHour, startMinute] = input.windowStart!.split(":").map(Number);
  const [endHour, endMinute] = input.windowEnd!.split(":").map(Number);
  let start = anchorLocal.startOf("day").set({
    hour: startHour,
    minute: startMinute,
  });
  if (start <= nowLocal) start = start.plus({ days: 1 });
  const adjustedEnd = start.set({ hour: endHour, minute: endMinute });
  if (adjustedEnd <= start) return null;
  return {
    intervalMinutes,
    startsAt: start.toUTC().toJSDate(),
    endsAt: adjustedEnd.toUTC().toJSDate(),
    windowStart: start.toFormat("HH:mm"),
    windowEnd: adjustedEnd.toFormat("HH:mm"),
  };
}

function formatInterval(minutes: number) {
  return minutes === 60 ? "каждый час" : `каждые ${minutes} минут`;
}

async function applyRecurringItemCadencePolicy(params: {
  ctx: BotContext;
  userId: string;
  item: PlannerItem;
  policies: ReminderPolicy[];
  draft: ReminderPolicyEditDraft;
  timezone: string;
  now: Date;
}) {
  const baseRule = recurringRuleForItemOrPolicies(params.item, params.policies);
  if (!baseRule || !params.draft.intervalMinutes || params.draft.windowEnd === undefined) {
    return false;
  }
  const parsedBase = parseCanonicalRecurrenceRule(baseRule);
  if (!parsedBase || parsedBase.kind === "legacy") return false;
  const windowStart = params.draft.windowStart ?? parsedBase.timeLocal;
  if (!windowStart) return false;
  const recurrenceRule = withRecurringPolicyTime(baseRule, windowStart);
  const nextFireAt = nextRecurringOccurrence({
    rule: recurrenceRule,
    after: params.now,
    timezone: params.timezone,
  });
  if (!nextFireAt) return false;

  const primaryPolicies = params.policies.filter(isPrimaryRecurringReminderPolicy);
  const target =
    primaryPolicies.find((policy) => {
      const parsed = parseCanonicalRecurrenceRule(policy.recurrenceRule);
      return parsed?.kind === parsedBase.kind;
    }) ?? primaryPolicies[0];
  const preservedSnooze = latestFutureSnooze(primaryPolicies, params.now);
  const metadata = {
    activeWindowStart: windowStart,
    activeWindowEnd: params.draft.windowEnd,
    stopCondition: params.draft.stopCondition ?? "until_done",
    stopOnItemComplete: true,
    ackAliases: params.draft.ackAliases ?? ["done"],
    recurrenceRuleVersion: "canonical-v2100",
    mutationSource: "recurring_item_reminder_policy_edit_session",
  };
  const policy = target
    ? await updateReminderPolicy({
        userId: params.userId,
        policyId: target.id,
        itemId: params.item.id,
        title: params.item.title,
        category: params.item.category ?? "recurring_task",
        policyType: "recurring",
        startsAt: null,
        endsAt: null,
        nextFireAt,
        recurrenceRule,
        intervalMinutes: params.draft.intervalMinutes,
        requireAck: true,
        onWindowEnd: "keep_open",
        catchUpMode: "one_immediate_then_resume",
        snoozedUntil: preservedSnooze,
        snoozeScope: preservedSnooze ? "policy" : null,
        metadata,
      })
    : await createReminderPolicyIfMissing({
        userId: params.userId,
        itemId: params.item.id,
        title: params.item.title,
        category: params.item.category ?? "recurring_task",
        policyType: "recurring",
        timezone: params.timezone,
        startsAt: null,
        endsAt: null,
        nextFireAt,
        recurrenceRule,
        intervalMinutes: params.draft.intervalMinutes,
        requireAck: true,
        onWindowEnd: "keep_open",
        catchUpMode: "one_immediate_then_resume",
        snoozedUntil: preservedSnooze,
        snoozeScope: preservedSnooze ? "policy" : null,
        idempotencyKey: `${params.item.id}:recurring-edit:${recurrenceRule}:${params.draft.intervalMinutes}:${windowStart}:${params.draft.windowEnd ?? "open"}`,
        metadata,
      });
  if (!policy) return false;

  await cancelPendingRemindersForPolicy({ userId: params.userId, policyId: policy.id });
  for (const duplicate of primaryPolicies.filter((candidate) => candidate.id !== policy.id)) {
    await cancelPendingRemindersForPolicy({ userId: params.userId, policyId: duplicate.id });
    await updateReminderPolicy({
      userId: params.userId,
      policyId: duplicate.id,
      status: "cancelled",
      nextFireAt: null,
      metadata: {
        supersededByPolicyId: policy.id,
        supersededBy: "recurring_item_reminder_policy_edit_session",
        supersededAt: params.now.toISOString(),
      },
    });
  }
  await materializeNextPolicyReminder(policy, nextFireAt, { now: params.now });
  await clearActiveReminderPolicyEditSession({ userId: params.userId, reason: "policy_applied" });
  await replyAndRecord(
    params.ctx,
    [
      "Готово:",
      params.item.title,
      "",
      `🔔 ${formatHumanReminderPolicy(policy, params.timezone, {
        now: params.now,
        includeMarker: false,
      })}`,
    ].join("\n"),
    { reply_markup: itemMenuKeyboard(params.item.id) },
  );
  return true;
}

function recurringRuleForItemOrPolicies(item: PlannerItem, policies: ReminderPolicy[]) {
  const metadataRule =
    typeof item.metadata?.recurrenceRule === "string" ? item.metadata.recurrenceRule : null;
  if (isCanonicalRecurringRule(metadataRule)) return metadataRule;
  return (
    policies.find((policy) => policy.status === "active" && isCanonicalRecurringRule(policy.recurrenceRule))
      ?.recurrenceRule ?? null
  );
}

function isPrimaryRecurringReminderPolicy(policy: ReminderPolicy) {
  return (
    policy.status === "active" &&
    (isCanonicalRecurringRule(policy.recurrenceRule) ||
      (policy.policyType === "nag_until_ack" && Boolean(policy.intervalMinutes) && policy.requireAck))
  );
}

function isCanonicalRecurringRule(rule: string | null) {
  const parsed = parseCanonicalRecurrenceRule(rule);
  return Boolean(parsed && parsed.kind !== "legacy");
}

function latestFutureSnooze(policies: ReminderPolicy[], now: Date) {
  const snoozes = policies
    .map((policy) => policy.snoozedUntil)
    .filter((date): date is Date => Boolean(date && date > now))
    .sort((left, right) => right.getTime() - left.getTime());
  return snoozes[0] ?? null;
}
