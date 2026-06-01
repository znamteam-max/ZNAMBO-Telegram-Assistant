import { DateTime } from "luxon";

import { getEnv } from "@/lib/env";

import type { ActionPlan, ActionPlanItem, ActionPlanReminder } from "./schemas";
import { nextOccurrence } from "./heuristicActionPlanner";

const dayCodes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export function validateActionPlan(params: {
  plan: ActionPlan;
  text: string;
  timezone: string;
  now: Date;
}): ActionPlan {
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  if (params.plan.intent !== "plan") return params.plan;

  const actions = params.plan.actions.map((action) =>
    validateAction({ action, text: params.text, timezone: params.timezone, nowLocal }),
  );

  if (!actions.length && params.text.trim()) {
    return {
      ...params.plan,
      intent: "clarify",
      reply: "Я не хочу угадывать. Уточни, пожалуйста, что именно записать или напомнить.",
      clarificationQuestions: ["Что записать?", "На какое время поставить напоминание?"],
    };
  }

  return {
    ...params.plan,
    actions,
    requiresConfirmation:
      params.plan.requiresConfirmation || actions.some((action) => action.requiresConfirmation),
  };
}

function validateAction(params: {
  action: ActionPlanItem;
  text: string;
  timezone: string;
  nowLocal: DateTime;
}): ActionPlanItem {
  const timezone = params.action.timezone || params.timezone;
  let action = { ...params.action, timezone };

  if (action.actionType === "tentative_event") {
    action = { ...action, kind: "tentative_event", tentative: true };
  }

  if (action.actionType === "recurring_task") {
    const recurrence = action.recurrence ?? {
      frequency: "daily" as const,
      daysOfWeek: [...dayCodes],
      timeLocal: getEnv().DEFAULT_MORNING_REMINDER_TIME,
      repeatUntilAck: true,
    };
    const daysOfWeek = recurrence.daysOfWeek.length ? recurrence.daysOfWeek : [...dayCodes];
    const timeLocal = recurrence.timeLocal || getEnv().DEFAULT_MORNING_REMINDER_TIME;
    const next = action.dueAtLocal ?? nextOccurrence(params.nowLocal, daysOfWeek, timeLocal);
    action = {
      ...action,
      kind: "recurring_task",
      dueAtLocal: next,
      recurrence: {
        frequency: daysOfWeek.length === 7 ? "daily" : "weekly",
        daysOfWeek,
        timeLocal,
        repeatUntilAck: recurrence.repeatUntilAck || /пока\s+.*подтверж/i.test(params.text),
      },
    };
  }

  if (action.startAtLocal && !action.endAtLocal && action.durationMinutes) {
    const start = DateTime.fromISO(action.startAtLocal, { zone: timezone });
    if (start.isValid) {
      action = {
        ...action,
        endAtLocal: start.plus({ minutes: action.durationMinutes }).toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      };
    }
  }

  const reminders = normalizeReminders(action, params.nowLocal, timezone);
  return { ...action, reminders };
}

function normalizeReminders(
  action: ActionPlanItem,
  nowLocal: DateTime,
  timezone: string,
): ActionPlanReminder[] {
  let reminders = [...action.reminders];

  if (action.kind === "event" && !reminders.length) {
    reminders = [
      { type: "event_before", scheduledAtLocal: null, offsetMinutesBefore: 60, repeatUntilAck: false, payload: {} },
      { type: "15m", scheduledAtLocal: null, offsetMinutesBefore: 15, repeatUntilAck: false, payload: {} },
    ];
  }

  if (action.kind === "tentative_event" && action.startAtLocal) {
    const hasFollowup = reminders.some((reminder) => reminder.type === "followup");
    if (!hasFollowup) {
      reminders.push({
        type: "followup",
        scheduledAtLocal: DateTime.fromISO(action.startAtLocal, { zone: timezone })
          .minus({ minutes: 10 })
          .toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        offsetMinutesBefore: null,
        repeatUntilAck: false,
        payload: { prompt: "Подтверди, состоится ли tentative-событие." },
      });
    }
  }

  if (action.kind === "recurring_task" && !reminders.length && action.dueAtLocal) {
    reminders.push({
      type: "recurring",
      scheduledAtLocal: action.dueAtLocal,
      offsetMinutesBefore: null,
      repeatUntilAck: action.recurrence?.repeatUntilAck ?? true,
      payload: {},
    });
  }

  return reminders
    .map((reminder) => materializeReminderLocal(action, reminder, timezone))
    .filter((reminder): reminder is ActionPlanReminder => {
      if (!reminder.scheduledAtLocal) return true;
      const scheduled = DateTime.fromISO(reminder.scheduledAtLocal, { zone: timezone });
      return scheduled.isValid && scheduled > nowLocal;
    })
    .sort((a, b) => {
      if (!a.scheduledAtLocal || !b.scheduledAtLocal) return 0;
      return a.scheduledAtLocal.localeCompare(b.scheduledAtLocal);
    });
}

function materializeReminderLocal(
  action: ActionPlanItem,
  reminder: ActionPlanReminder,
  timezone: string,
): ActionPlanReminder {
  const base = action.startAtLocal ?? action.dueAtLocal;
  if (!base) return reminder;
  if (reminder.scheduledAtLocal) return reminder;
  const baseLocal = DateTime.fromISO(base, { zone: timezone });
  let scheduled: DateTime | null = null;
  if (reminder.offsetMinutesBefore) {
    scheduled = baseLocal.minus({ minutes: reminder.offsetMinutesBefore });
  } else {
    switch (reminder.type) {
      case "24h":
        scheduled = baseLocal.minus({ hours: 24 });
        break;
      case "day_morning":
        scheduled = baseLocal.startOf("day").plus({ hours: 9 });
        break;
      case "1h":
      case "event_before":
        scheduled = baseLocal.minus({ hours: 1 });
        break;
      case "30m":
        scheduled = baseLocal.minus({ minutes: 30 });
        break;
      case "15m":
        scheduled = baseLocal.minus({ minutes: 15 });
        break;
      case "followup":
      case "training_followup":
      case "after_event":
        scheduled = action.endAtLocal
          ? DateTime.fromISO(action.endAtLocal, { zone: timezone }).plus({ minutes: 15 })
          : baseLocal.plus({ hours: 1 });
        break;
      default:
        scheduled = baseLocal;
    }
  }
  if (!scheduled?.isValid) return reminder;
  return {
    ...reminder,
    scheduledAtLocal: scheduled.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
  };
}
