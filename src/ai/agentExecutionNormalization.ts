import { DateTime } from "luxon";

import type {
  AgentExecution,
  AgentItemUpdate,
  AgentReminderPolicy,
} from "@/ai/schemas/agentExecution";

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function normalizeAgentExecutionProposal(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
  activeContext: string;
}): AgentExecution {
  const interval = normalizeIntervalWindow(params);
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
  const startHour = extractClockAfter(params.text, /(?:^|\s)с\s+/i);
  const endHour = extractClockAfter(params.text, /(?:^|\s)до\s+/i);
  const action = params.execution.actionPlan?.actions[0];
  if (!intervalMinutes || !startHour || !endHour || !action) return params.execution;

  const localDay = DateTime.fromJSDate(params.now, { zone: "utc" })
    .setZone(params.timezone)
    .plus({ days: /завтра/i.test(params.text) ? 1 : 0 });
  const startsAtLocal = localDay
    .set({ hour: startHour.hour, minute: startHour.minute, second: 0, millisecond: 0 })
    .toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const endsAtLocal = localDay
    .set({ hour: endHour.hour, minute: endHour.minute, second: 0, millisecond: 0 })
    .toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const title = extractIntervalTaskTitle(params.text) ?? action.title;
  const requireAck = /пока\s+не\s+(?:отмеч|подтверд|сдела|готов)/i.test(params.text);
  const normalizedAction = {
    ...action,
    actionType: "task" as const,
    kind: "task" as const,
    title,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: endsAtLocal,
    durationMinutes: null,
  };
  const normalizedPolicy: AgentReminderPolicy = {
    operation: "create_interval_window_policy",
    itemIds: [],
    itemTitle: title,
    title,
    category: requireAck ? "nag_until_done" : "project",
    policyType: "interval_window",
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
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
  };

  return {
    ...params.execution,
    intent: "create_plan" as const,
    actionPlan: params.execution.actionPlan
      ? {
          ...params.execution.actionPlan,
          intent: "plan" as const,
          actions: [normalizedAction],
          clarificationQuestions: [],
        }
      : null,
    itemUpdates: [],
    reminderPolicies: [
      normalizedPolicy,
      ...params.execution.reminderPolicies.filter(
        (policy) =>
          policy.policyType !== "interval_window" &&
          policy.intervalMinutes !== intervalMinutes &&
          policy.itemTitle !== action.title,
      ),
    ],
    clarificationQuestions: [],
  };
}

function normalizeLongTermRecurrence(params: {
  execution: AgentExecution;
  text: string;
}) {
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
  const exposeManagementButtons =
    /(кнопк|перенос|отмен|итог|редакт|удален|удалён)/i.test(params.text);
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
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
  };
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
  const match = text.match(
    new RegExp(`${prefix.source}(\\d{1,2})(?:[.:](\\d{2}))?`, prefix.flags),
  );
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2] ?? 0) };
}

function extractIntervalTaskTitle(text: string) {
  const match = text.match(/^(.*?)\s+(?:сегодня|завтра)\s+до\s+\d/i);
  return match?.[1]?.trim() || null;
}

function extractContextPlannerItemIds(activeContext: string) {
  const ids = new Set<string>();
  for (const line of activeContext.split("\n")) {
    if (
      !/status=active;|:\s*(?:event|training|preparation_task|tentative_event|task)\s/i.test(
        line,
      )
    ) {
      continue;
    }
    const match = line.match(new RegExp(`(?:^|\\s)id=(${UUID_PATTERN})(?:;|\\s|$)`, "i"));
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids];
}
