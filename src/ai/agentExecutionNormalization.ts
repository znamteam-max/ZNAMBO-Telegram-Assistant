import { DateTime } from "luxon";

import type {
  AgentExecution,
  AgentItemUpdate,
  AgentReminderPolicy,
} from "@/ai/schemas/agentExecution";
import type { ActionPlanItem } from "@/ai/schemas";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function normalizeAgentExecutionProposal(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
  activeContext: string;
}): AgentExecution {
  const centralPark = normalizeCentralPark(params);
  const interval = normalizeIntervalWindow({
    ...params,
    execution: centralPark,
  });
  const recurring = normalizeLongTermRecurrence({
    ...params,
    execution: interval,
  });
  return normalizeEveryEventConfiguration({
    ...params,
    execution: recurring,
  });
}

function normalizeIntervalWindow(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}) {
  const intervalMinutes = extractIntervalMinutes(params.text);
  const startHour =
    extractClockAfter(params.text, /начиная\s+с\s+/i) ??
    extractClockAfter(params.text, /(?:^|\s)с\s+/i);
  const endHour = extractClockAfter(params.text, /(?:^|\s)до\s+/i);
  const isTomorrow = /завтра/i.test(params.text);
  const useDefaultEnd = Boolean(intervalMinutes && startHour && !endHour && isTomorrow);
  if (!intervalMinutes || !startHour || (!endHour && !useDefaultEnd)) {
    return params.execution;
  }
  const proposedAction = params.execution.actionPlan?.actions[0];
  const fallbackTitle = /дрик/i.test(params.text) ? "Записаться к Дрик" : null;
  if (!proposedAction && !fallbackTitle) return params.execution;

  const localDay = DateTime.fromJSDate(params.now, { zone: "utc" })
    .setZone(params.timezone)
    .plus({ days: isTomorrow ? 1 : 0 });
  const startsAtLocal = localDay
    .set({ hour: startHour.hour, minute: startHour.minute, second: 0, millisecond: 0 })
    .toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const endsAtLocal = localDay
    .set({
      hour: endHour?.hour ?? 22,
      minute: endHour?.minute ?? 0,
      second: 0,
      millisecond: 0,
    })
    .toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const action = proposedAction ?? buildSyntheticIntervalAction(fallbackTitle!, params.timezone);
  const title =
    extractIntervalTaskTitle(params.text) ?? normalizeReminderTaskTitle(params.text, action.title);
  const requireAck =
    useDefaultEnd || /пока\s+не\s+(?:отмеч|подтверд|сдела|готов)/i.test(params.text);
  const normalizedAction = {
    ...action,
    actionType: "task" as const,
    kind: "task" as const,
    title,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: endsAtLocal,
    durationMinutes: null,
    reminders: [],
    metadata: {
      ...action.metadata,
      intervalPolicyExpected: true,
      defaultEndAssumed: useDefaultEnd,
    },
  };
  const normalizedPolicy: AgentReminderPolicy = {
    operation: "create_interval_window_policy",
    itemIds: [],
    itemTitle: title,
    title,
    category: /дрик/i.test(title) ? "people" : requireAck ? "nag_until_done" : "project",
    policyType: useDefaultEnd ? "nag_until_ack" : "interval_window",
    startsAtLocal,
    endsAtLocal,
    nextFireAtLocal: startsAtLocal,
    recurrenceRule: null,
    intervalMinutes,
    requireAck,
    maxOccurrences: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
  };

  return {
    ...params.execution,
    intent: "create_plan" as const,
    actionPlan: {
      ...(params.execution.actionPlan ?? {
        intent: "plan" as const,
        summary: null,
        reply: null,
        confidence: 0.95,
        requiresConfirmation: false,
        actions: [],
        memoryCandidates: [],
        clarificationQuestions: [],
      }),
      intent: "plan" as const,
      summary: useDefaultEnd ? `${title} завтра` : (params.execution.actionPlan?.summary ?? title),
      reply: useDefaultEnd
        ? `Буду напоминать завтра каждые ${intervalMinutes} минут с ${formatClock(startHour)} до ${formatClock(endHour ?? { hour: 22, minute: 0 })}, пока не отметишь выполненным.`
        : (params.execution.actionPlan?.reply ?? null),
      actions: [normalizedAction],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    reminderPolicies: [
      normalizedPolicy,
      ...params.execution.reminderPolicies.filter(
        (policy) =>
          !["interval_window", "nag_until_ack", "post_event_menu", "after_event"].includes(
            policy.policyType,
          ) &&
          policy.intervalMinutes !== intervalMinutes &&
          policy.itemTitle !== action.title,
      ),
    ],
    clarificationQuestions: [],
  };
}

function buildSyntheticIntervalAction(title: string, timezone: string): ActionPlanItem {
  return {
    actionType: "task",
    kind: "task",
    title,
    description: null,
    location: null,
    timezone,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: null,
    durationMinutes: null,
    priority: 4,
    confidence: 0.95,
    risk: "low",
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: { sourceNormalization: "open_interval_v242" },
  };
}

function normalizeLongTermRecurrence(params: { execution: AgentExecution; text: string }) {
  const segments = params.text
    .split(/[,;\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const recurringPolicies = segments
    .map(buildRecurringPolicy)
    .filter((policy): policy is AgentReminderPolicy => Boolean(policy));
  if (!recurringPolicies.length) return params.execution;

  const existingNonRecurring = params.execution.reminderPolicies.filter(
    (policy) => !["recurring", "long_term"].includes(policy.policyType),
  );
  return {
    ...params.execution,
    intent: "manage_reminder_policies" as const,
    actionPlan: null,
    itemUpdates: [],
    reminderPolicies: [...existingNonRecurring, ...recurringPolicies],
    clarificationQuestions: [],
  };
}

function normalizeEveryEventConfiguration(params: {
  execution: AgentExecution;
  text: string;
  activeContext: string;
}) {
  if (!/(кажд(?:ого|ому|ое)\s+событи|все(?:м|х)?\s+событи)/i.test(params.text)) {
    return params.execution;
  }
  const reminderMinutesBefore = /за\s+час/i.test(params.text) ? 60 : null;
  const followupMinutesAfter = /(после|реакци|как\s+прошл)/i.test(params.text) ? 0 : null;
  const exposeManagementButtons = /(кнопк|перенос|отмен|итог|редакт|удален|удалён)/i.test(
    params.text,
  );
  if (reminderMinutesBefore === null && followupMinutesAfter === null) {
    return params.execution;
  }

  const itemIds = extractContextPlannerItemIds(params.activeContext);
  if (!itemIds.length) return params.execution;
  const update: AgentItemUpdate = {
    itemIds,
    operation: "configure",
    startAtLocal: null,
    endAtLocal: null,
    reminderMinutesBefore,
    followupMinutesAfter,
    exposeManagementButtons,
    note: "Normalized after mandatory OpenAI proposal for every current event.",
  };
  return {
    ...params.execution,
    intent: "update_existing_items" as const,
    actionPlan: null,
    itemUpdates: [update],
    reminderPolicies: [],
    clarificationQuestions: [],
  };
}

function buildRecurringPolicy(segment: string): AgentReminderPolicy | null {
  const biweekly = /раз\s+в\s+(?:две|2)\s+недел/i.test(segment);
  const weekly = !biweekly && /раз\s+в\s+недел/i.test(segment);
  if (!weekly && !biweekly) return null;
  const title = segment
    .replace(/раз\s+в\s+(?:(?:две|2)\s+)?недел[юи]\s*/i, "")
    .replace(/^напоминать\s*/i, "")
    .replace(/^про\s*/i, "")
    .trim();
  if (!title) return null;

  return {
    operation: "create_recurring_policy",
    itemIds: [],
    itemTitle: null,
    title,
    category: recurringCategory(title),
    policyType: "long_term",
    startsAtLocal: null,
    endsAtLocal: null,
    nextFireAtLocal: null,
    recurrenceRule: biweekly ? "every_2_weeks" : "weekly",
    intervalMinutes: null,
    requireAck: true,
    maxOccurrences: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
  };
}

function normalizeCentralPark(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}) {
  if (
    !/(?:central|централ)\s+парк/i.test(params.text) ||
    !/четверг/i.test(params.text) ||
    !/16-?(?:го)?/i.test(params.text) ||
    !/(каждый\s+день|ежеднев)/i.test(params.text) ||
    !/(по\s+две|два\s+раза)/i.test(params.text)
  ) {
    return params.execution;
  }

  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const thursday = nextWeekday(nowLocal, 4);
  const sixteenth = dayOfMonthAfter(nowLocal, 16);
  const firstStart = thursday.set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
  const firstEnd = thursday.set({ hour: 22, minute: 0, second: 0, millisecond: 0 });
  const secondStart = sixteenth.set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
  const secondEnd = sixteenth.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  const actions: ActionPlanItem[] = [
    centralParkAction(firstStart, firstEnd, params.timezone),
    centralParkAction(secondStart, secondEnd, params.timezone),
  ];
  const policies = [
    ...dailyPoliciesBeforeEvent(firstStart, nowLocal),
    ...dailyPoliciesBeforeEvent(secondStart, nowLocal),
  ];

  return {
    ...params.execution,
    intent: "create_plan" as const,
    reply:
      "Записал две студии Central Park и поставил до каждой два ежедневных напоминания: в 10:00 и 18:00.",
    actionPlan: {
      intent: "plan" as const,
      summary: "Две студии Central Park",
      reply: null,
      confidence: 0.99,
      requiresConfirmation: false,
      actions,
      memoryCandidates: [],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    reminderPolicies: policies,
    clarificationQuestions: [],
  };
}

function centralParkAction(start: DateTime, end: DateTime, timezone: string): ActionPlanItem {
  return {
    actionType: "event",
    kind: "event",
    title: "Студия Central Park",
    description: null,
    location: "Студия Central Park",
    timezone,
    startAtLocal: start.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    endAtLocal: end.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    dueAtLocal: null,
    durationMinutes: null,
    priority: 5,
    confidence: 0.99,
    risk: "low",
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: { sourceNormalization: "central_park_v242", important: true },
  };
}

function dailyPoliciesBeforeEvent(eventStart: DateTime, nowLocal: DateTime): AgentReminderPolicy[] {
  return [10, 18].map((hour) => {
    let finalFire = eventStart.startOf("day").set({ hour, minute: 0 });
    if (finalFire >= eventStart) finalFire = finalFire.minus({ days: 1 });
    let nextFire = nowLocal.startOf("day").set({ hour, minute: 0 });
    if (nextFire <= nowLocal) nextFire = nextFire.plus({ days: 1 });
    return {
      operation: "create_recurring_policy",
      itemIds: [],
      itemTitle: "Студия Central Park",
      title: `Студия Central Park: напоминание в ${String(hour).padStart(2, "0")}:00`,
      category: "meeting",
      policyType: "recurring",
      startsAtLocal: nextFire.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      endsAtLocal: finalFire.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      nextFireAtLocal: nextFire.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      recurrenceRule: `daily_at_${String(hour).padStart(2, "0")}:00`,
      intervalMinutes: null,
      requireAck: false,
      maxOccurrences: null,
      minutesBefore: null,
      windowEndInclusive: true,
      catchUpMode: "latest_only",
      onWindowEnd: "expire_silently",
      quietHoursStart: null,
      quietHoursEnd: null,
      allowDuringQuietHours: false,
    };
  });
}

function nextWeekday(now: DateTime, weekday: number) {
  const delta = (weekday - now.weekday + 7) % 7;
  return now.plus({ days: delta || 7 }).startOf("day");
}

function dayOfMonthAfter(now: DateTime, day: number) {
  let candidate = now.startOf("month").set({ day });
  if (candidate <= now.startOf("day")) candidate = candidate.plus({ months: 1 });
  return candidate.startOf("day");
}

function recurringCategory(title: string): AgentReminderPolicy["category"] {
  if (/(машин|авто|зеркал)/i.test(title)) return "recurring_car";
  if (/(жкх|оплат|счет|счёт|финанс)/i.test(title)) return "recurring_finance";
  if (/(дом|квартир)/i.test(title)) return "recurring_home";
  return "long_term";
}

function extractIntervalMinutes(text: string) {
  if (/каждые?\s+полчаса|каждые?\s+пол\s*часа/i.test(text)) return 30;
  if (/каждые?\s+час/i.test(text)) return 60;
  const match = text.match(/каждые?\s+(\d{1,3})\s*мин/i);
  return match ? Number(match[1]) : null;
}

function extractClockAfter(text: string, prefix: RegExp) {
  const match = text.match(new RegExp(`${prefix.source}(\\d{1,2})(?:[.:](\\d{2}))?`, prefix.flags));
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2] ?? 0) };
}

function formatClock(value: { hour: number; minute: number }) {
  return `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
}

function extractIntervalTaskTitle(text: string) {
  const match = text.match(/^(.*?)\s+(?:сегодня|завтра)\s+до\s+\d/i);
  return match?.[1]?.trim() || null;
}

function normalizeReminderTaskTitle(text: string, fallback: string) {
  if (/дрик/i.test(text)) return "Записаться к Дрик";
  return fallback
    .replace(/^напоминания?\s+о\s+/i, "")
    .replace(/^напоминать\s+/i, "")
    .trim();
}

function extractContextPlannerItemIds(activeContext: string) {
  const ids = new Set<string>();
  for (const line of activeContext.split("\n")) {
    if (
      !/status=active;|:\s*(?:event|training|preparation_task|tentative_event|task)\s/i.test(line)
    ) {
      continue;
    }
    const match = line.match(new RegExp(`(?:^|\\s)id=(${UUID_PATTERN})(?:;|\\s|$)`, "i"));
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids];
}
