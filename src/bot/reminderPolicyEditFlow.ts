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
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";
import {
  clearActiveReminderPolicyEditSession,
  getActiveReminderPolicyEditSession,
} from "@/services/reminderPolicyEditSessions";

export async function handleReminderPolicyEditTurn(
  ctx: BotContext,
  text: string,
  timezone: string,
) {
  const owner = requireOwner(ctx);
  const session = await getActiveReminderPolicyEditSession({ userId: owner.id }).catch(() => null);
  if (!session) return false;
  const parsed = parseReminderCadence({
    text,
    itemAnchor: session.item.startAt ?? session.item.dueAt,
    timezone: session.item.timezone || timezone,
    now: new Date(),
  });
  if (!parsed) {
    await replyAndRecord(
      ctx,
      `Я настраиваю напоминания для «${session.item.title}». Напиши интервал и окно, например: «каждый час с 8 до 18, пока не отмечу».`,
    );
    return true;
  }
  const active = (await listReminderPoliciesForItem(owner.id, session.item.id, 30)).find(
    (policy) => policy.status === "active" && policy.policyType === "nag_until_ack",
  );
  const metadata = {
    activeWindowStart: parsed.windowStart,
    activeWindowEnd: parsed.windowEnd,
    stopCondition: "until_done",
    stopOnItemComplete: true,
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
      `Напоминания: ❗ ${parsed.intervalMinutes === 60 ? "каждый час" : `каждые ${parsed.intervalMinutes} мин`} с ${parsed.windowStart} до ${parsed.windowEnd}, пока не отмечу`,
      `Окно: ${formatRuWeekdayDateRange(parsed.startsAt, parsed.endsAt, session.item.timezone || timezone)}`,
    ].join("\n"),
    { reply_markup: itemMenuKeyboard(session.item.id) },
  );
  return true;
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
