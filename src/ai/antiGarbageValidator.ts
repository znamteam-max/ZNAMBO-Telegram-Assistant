import type { ActionPlan } from "./schemas";
import type { AgentReminderPolicy } from "./schemas/agentExecution";
import type { AssistantDecision } from "./schemas/assistantDecision";
import { isHardManagementText } from "@/agent/hardManagementIntent";
import { hasNegativeReminderIntent } from "@/domain/reminderIntent";

export type PlannerValidationResult = {
  ok: boolean;
  warnings: string[];
};

const commandTitlePattern =
  /^(дай|покажи|открой|отредактируй|отредактирую|что\s+у\s+меня)(?:\s|$)/i;

const tentativePattern =
  /(возможно|возможный|возможная|пока\s+не\s+точно|tentative|под\s+вопросом)/i;
const timeWindowPattern = /(утром\s*\/\s*дн[её]м|утром|дн[её]м|в\s+течение\s+дня)/i;
const noTrainingReportPattern = /(сегодня|вчера).{0,80}без\s+(велик|велосипед|трениров)/i;

export function validatePlannerItemsBeforeSave(params: {
  plan: ActionPlan;
  originalMessage: string;
  decision?: AssistantDecision;
}): PlannerValidationResult {
  if (params.plan.intent !== "plan" || !params.plan.actions.length) {
    return { ok: true, warnings: [] };
  }

  const warnings: string[] = [];
  const original = params.originalMessage.trim();
  const originalLower = original.toLowerCase();
  const originalHasBullets = hasMultipleBulletMarkers(original);

  for (const action of params.plan.actions) {
    const title = action.title.trim();
    const normalizedTitle = normalize(title);

    if (
      original.length > 120 &&
      originalHasBullets &&
      normalize(original).includes(normalizedTitle) &&
      normalizedTitle.length > 90
    ) {
      warnings.push("item title looks like the whole original multi-line message");
    }

    if (commandTitlePattern.test(title)) {
      warnings.push("management command was converted into an item title");
    }
    if (isHardManagementText(title)) {
      warnings.push("hard management command was converted into an item title");
    }

    if (hasMultipleBulletMarkers(title)) {
      warnings.push("one item title contains multiple bullet markers");
    }

    if (
      params.decision?.intent === "ordered_task_list" &&
      action.kind === "event" &&
      !action.startAtLocal
    ) {
      warnings.push("ordered list item became an event without time");
    }

    if (noTrainingReportPattern.test(originalLower) && action.kind === "task") {
      warnings.push("training report was converted into a task");
    }

    if (tentativePattern.test(originalLower) && !action.tentative && action.kind !== "note") {
      warnings.push("tentative source text produced a non-tentative item");
    }

    if (
      timeWindowPattern.test(originalLower) &&
      !hasExplicitClock(originalLower) &&
      hasExactLocalTime(action)
    ) {
      warnings.push("exact time was assigned even though the user gave only a time window");
    }

    if (
      /(3[:.]30|03[:.]30).{0,30}(моск|moscow)/i.test(originalLower) &&
      /15:30/.test(`${action.startAtLocal ?? ""}${action.dueAtLocal ?? ""}`)
    ) {
      warnings.push("03:30 Moscow was converted to 15:30");
    }
  }

  return { ok: warnings.length === 0, warnings: [...new Set(warnings)] };
}

export function buildValidationFailureReply(warnings: string[]): string {
  if (!warnings.length) {
    return "Я не хочу создавать мусорную запись. Уточни, пожалуйста, что именно сохранить.";
  }
  if (warnings.some((warning) => warning.includes("management command"))) {
    return "Ок, это похоже на управление текущими задачами, а не новую задачу. Показываю текущие дела для редактирования.";
  }
  if (warnings.some((warning) => warning.includes("ordered list"))) {
    return "Это похоже на список дел. Не буду сохранять его одной встречей. Пришли список ещё раз или скажи, оставить пункты без времени.";
  }
  if (warnings.some((warning) => warning.includes("training report"))) {
    return "Похоже, это отчёт по тренировке, а не новая задача. Отмечу как тренировочный статус и не буду сохранять весь текст заголовком.";
  }
  if (warnings.some((warning) => warning.includes("explicit reminder intent has no committed policy"))) {
    return "Понял задачу, но не понял время напоминания. Когда напомнить: сейчас, через час или сегодня вечером?";
  }
  if (warnings.some((warning) => warning.includes("explicit reminder times are not fully materialized"))) {
    return "Понял задачу, но не смог однозначно привязать указанное время напоминания. Напиши время ещё раз, например: «сегодня в 18:00».";
  }
  if (warnings.some((warning) => warning.includes("interval policy is incomplete"))) {
    return "Понял повторяющееся напоминание, но не смог определить время начала или интервал. Когда начать и как часто напоминать?";
  }
  if (warnings.some((warning) => warning.includes("policy target is not present"))) {
    return "Понял правило напоминания, но не понял, к какой задаче его привязать. Назови задачу точнее.";
  }
  return `Не сохранил план из-за точной проверки: ${warnings[0]}. Уточни этот момент, остальное я уже понял.`;
}

export function validateReminderPoliciesBeforeSave(params: {
  plan: ActionPlan;
  policies: AgentReminderPolicy[];
  timezone: string;
  originalMessage?: string;
}): PlannerValidationResult {
  const warnings: string[] = [];
  const actionTitles = new Set(params.plan.actions.map((action) => normalize(action.title)));

  for (const policy of params.policies) {
    if (
      policy.policyType === "interval_window" &&
      (!policy.startsAtLocal || !policy.endsAtLocal || !policy.intervalMinutes)
    ) {
      warnings.push(`interval policy is incomplete: ${policy.title}`);
    }
    if (
      policy.policyType === "nag_until_ack" &&
      (!policy.startsAtLocal || !policy.intervalMinutes)
    ) {
      warnings.push(`interval policy is incomplete: ${policy.title}`);
    }
    if (policy.startsAtLocal && policy.endsAtLocal) {
      const start = Date.parse(`${policy.startsAtLocal}${zoneSuffix(policy.startsAtLocal)}`);
      const end = Date.parse(`${policy.endsAtLocal}${zoneSuffix(policy.endsAtLocal)}`);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        warnings.push(`policy window is invalid: ${policy.title}`);
      }
    }
    if (
      policy.itemIds.length === 0 &&
      policy.itemTitle &&
      !actionTitles.has(normalize(policy.itemTitle))
    ) {
      warnings.push(`policy target is not present in prepared plan: ${policy.itemTitle}`);
    }
    if (
      ["after_event", "post_event_menu"].includes(policy.policyType) &&
      params.plan.actions.some((action) => action.metadata?.intervalPolicyExpected === true)
    ) {
      warnings.push(`interval task cannot create a post-event menu: ${policy.title}`);
    }
  }

  const original = params.originalMessage ?? "";
  const actionReminders = params.plan.actions.flatMap((action) => action.reminders);
  if (containsReminderIntent(original) && !params.policies.length && !actionReminders.length) {
    warnings.push("explicit reminder intent has no committed policy");
  }
  const explicitTimes = extractExplicitReminderTimes(original);
  if (explicitTimes.length) {
    const concreteTimes = new Set(
      [
        ...actionReminders.map((reminder) => reminder.scheduledAtLocal?.slice(11, 16)),
        ...params.policies.map((policy) => policy.nextFireAtLocal?.slice(11, 16)),
      ].filter((value): value is string => Boolean(value)),
    );
    if (explicitTimes.some((time) => !concreteTimes.has(time))) {
      warnings.push("explicit reminder times are not fully materialized");
    }
  }

  return { ok: warnings.length === 0, warnings: [...new Set(warnings)] };
}

function containsReminderIntent(text: string) {
  if (hasNegativeReminderIntent(text)) return false;
  return /(напомн|напоминан|кажд(?:ый|ые|ую)\s+(?:час|день|недел|полчас)|пока\s+не\s+сдел)/i.test(text);
}

function extractExplicitReminderTimes(text: string) {
  const index = text.search(/напоминан|напомн/i);
  if (index < 0) return [];
  const times = new Set<string>();
  for (const match of text.slice(index).matchAll(/\b(\d{1,2})[.:](\d{2})\b/g)) {
    times.add(`${String(Number(match[1])).padStart(2, "0")}:${match[2]}`);
  }
  return [...times];
}

function hasMultipleBulletMarkers(text: string) {
  const matches = text.match(/(^|\n)\s*(?:[-*•]|\d+[.)])\s+/g);
  return (matches?.length ?? 0) >= 2;
}

function hasExactLocalTime(action: ActionPlan["actions"][number]) {
  if (action.metadata?.timeUnspecified === true) return false;
  return Boolean(action.startAtLocal || action.dueAtLocal);
}

function hasExplicitClock(text: string) {
  return /(?:^|\s)(?:в|с|до)\s*\d{1,2}(?:[.:]\d{2})?(?:\s|,|$)/i.test(text);
}

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function zoneSuffix(value: string) {
  return /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? "" : "Z";
}
