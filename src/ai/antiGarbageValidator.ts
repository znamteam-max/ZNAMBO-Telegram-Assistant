import type { ActionPlan } from "./schemas";
import type { AgentReminderPolicy } from "./schemas/agentExecution";
import type { AssistantDecision } from "./schemas/assistantDecision";
import { isHardManagementText } from "@/agent/hardManagementIntent";

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
  return "Я остановил сохранение: план выглядит неоднозначно. Лучше уточним, чтобы не создать мусорную запись.";
}

export function validateReminderPoliciesBeforeSave(params: {
  plan: ActionPlan;
  policies: AgentReminderPolicy[];
  timezone: string;
}): PlannerValidationResult {
  const warnings: string[] = [];
  const actionTitles = new Set(params.plan.actions.map((action) => normalize(action.title)));

  for (const policy of params.policies) {
    if (
      ["interval_window", "nag_until_ack"].includes(policy.policyType) &&
      (!policy.startsAtLocal || !policy.endsAtLocal || !policy.intervalMinutes)
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

  return { ok: warnings.length === 0, warnings: [...new Set(warnings)] };
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
