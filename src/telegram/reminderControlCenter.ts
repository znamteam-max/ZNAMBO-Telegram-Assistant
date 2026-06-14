import {
  getReminderPolicyById,
  listReminderPoliciesByStatus,
} from "@/db/queries/reminderPolicies";
import type { ReminderPolicy } from "@/db/schema";
import {
  classifyTimelineItem,
  compareTimelineEntries,
  getBasePriority,
  getEffectivePriority,
  getUrgencyBoost,
} from "@/domain/timelineClassification";
import { importanceLabel, importanceMarker, urgencyExplanation } from "@/domain/importance";
import {
  entityListKeyboard,
  reminderEmptyKeyboard,
  reminderPolicyCardKeyboard,
} from "@/bot/keyboards";
import { buildUserTimelineView } from "@/services/userTimeline";
import { reconcileActiveReminderPolicies } from "@/services/reminderPolicyReconciler";
import { logger } from "@/lib/logger";
import { formatHumanReminderPolicy } from "@/domain/reminderPolicyPresentation";
import { formatRuWeekdayDateTime } from "@/domain/dateTime";

export async function renderReminderControlCenter(params: {
  userId: string;
  timezone: string;
  scope?: string | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const scope = params.scope?.toLowerCase() || "active";
  await reconcileActiveReminderPolicies({ now, limit: 200 }).catch((error) => {
    logger.warn("Reminder control reconciliation failed without blocking view", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const timeline = scope === "paused" ? null : await buildUserTimelineView(params);
  const policies =
    scope === "paused"
      ? await listReminderPoliciesByStatus(params.userId, "paused", 100)
      : timeline!.policies;
  const filtered = groupCampaignPolicies(policies)
    .filter((policy) => policyMatchesScope(policy, scope, now, params.timezone))
    .sort((a, b) =>
      compareTimelineEntries({ policy: a }, { policy: b }, now, params.timezone),
    );
  const title = scope === "paused" ? "Напоминания на паузе" : "Правила напоминаний";
  const futureItems =
    timeline?.items.filter((item) => {
      const anchor = item.startAt ?? item.dueAt;
      return item.source !== "yandex_external" && item.status === "active" && Boolean(anchor && anchor > now);
    }) ?? [];
  const taskCount = futureItems.filter((item) =>
    ["task", "preparation_task", "recurring_task"].includes(item.kind),
  ).length;
  const eventCount = futureItems.length - taskCount;
  const lines = [
    title,
    "",
    scope === "paused"
      ? null
      : "Здесь только повторяющиеся правила: каждый час, раз в неделю или перед событием.\nОбычные встречи и задачи смотри в /plan или /tasks.",
    scope === "paused" ? null : "",
    ...(filtered.length
      ? filtered.map(
          (policy, index) =>
            `${index + 1}. ${formatPolicyLine(policy, now, params.timezone)}`,
        )
      : [
          "Активных правил напоминаний нет.",
          "",
          "Но в плане есть:",
          `• будущих событий: ${eventCount}`,
          `• задач: ${taskCount}`,
          "",
          "Открыть план?",
        ]),
  ].filter((line): line is string => line !== null);
  return {
    text: lines.join("\n"),
    policies: filtered,
    keyboard: filtered.length
      ? entityListKeyboard(
          filtered.map((policy) => {
            const campaignGroup = String(policy.metadata?.campaignGroup ?? "");
            return campaignGroup
              ? { type: "campaign" as const, id: campaignGroup }
              : { type: "reminder_policy" as const, id: policy.id };
          }),
        )
      : reminderEmptyKeyboard(),
  };
}

export async function renderReminderPolicyCard(params: {
  userId: string;
  policyId: string;
  timezone: string;
  now?: Date;
}) {
  const policy = await getReminderPolicyById(params.policyId);
  if (!policy || policy.userId !== params.userId) return null;
  const now = params.now ?? new Date();
  const next = policy.nextFireAt
    ? formatRuWeekdayDateTime(policy.nextFireAt, policy.timezone || params.timezone, {
        includeYear: true,
      })
    : "нет";
  const window = [formatDate(policy.startsAt, policy.timezone), formatDate(policy.endsAt, policy.timezone)]
    .filter(Boolean)
    .join(" - ");
  return {
    policy,
    text: [
      policy.title,
      "",
      `Статус: ${policy.status}`,
      `Напоминания: ${formatHumanReminderPolicy(policy, policy.timezone, {
        includeNext: true,
        now,
        includeMarker: false,
      })}`,
      `Важность: ${importanceLabel(getBasePriority({ policy }))}`,
      `Сейчас: ${importanceLabel(getEffectivePriority({ policy }, now, params.timezone))}; ${urgencyExplanation(getUrgencyBoost({ policy }, now, params.timezone))}`,
      `Частота: ${formatFrequency(policy)}`,
      `Окно: ${window || "без ограничений"}`,
      `До выполнения: ${policy.requireAck ? "да" : "нет"}`,
      policy.snoozedUntil && policy.snoozedUntil > now
        ? `Отложено до: ${formatRuWeekdayDateTime(policy.snoozedUntil, policy.timezone)}`
        : `Следующее: ${next}`,
      `Категория: ${policy.category}`,
    ].join("\n"),
    keyboard: reminderPolicyCardKeyboard(policy),
  };
}

function policyMatchesScope(policy: ReminderPolicy, scope: string, now: Date, timezone: string) {
  if (scope === "active" || scope === "paused") return true;
  if (["content", "meetings", "meeting", "training", "finance", "car"].includes(scope)) {
    const category = scope === "meetings" ? "meeting" : scope;
    return policy.category === category || policy.category === `recurring_${category}`;
  }
  const classification = classifyTimelineItem({ policy }, now, timezone);
  if (scope === "today") return ["now", "today", "active_nag"].includes(classification);
  if (scope === "soon") return classification === "soon";
  if (scope === "longterm") return classification === "long_term";
  if (scope === "distant") return classification === "distant_priority";
  return true;
}

function formatPolicyLine(policy: ReminderPolicy, now: Date, timezone: string) {
  const marker = importanceMarker(getBasePriority({ policy })).split(" ")[0];
  return `${marker ? `${marker} · ` : ""}${policy.title}\n   ${formatHumanReminderPolicy(policy, timezone, {
    includeNext: true,
    now,
    includeMarker: false,
  })}`;
}

function formatFrequency(policy: ReminderPolicy) {
  if (!policy.intervalMinutes) return policy.recurrenceRule ?? "один раз";
  if (policy.intervalMinutes === 60) return "каждый час";
  if (policy.intervalMinutes % 60 === 0) {
    const hours = policy.intervalMinutes / 60;
    return hours <= 4 ? `каждые ${hours} часа` : `каждые ${hours} часов`;
  }
  return `каждые ${policy.intervalMinutes} мин`;
}

function formatDate(value: Date | null, timezone: string) {
  return value
    ? formatRuWeekdayDateTime(value, timezone)
    : null;
}

function groupCampaignPolicies(policies: ReminderPolicy[]) {
  const result = new Map<string, ReminderPolicy>();
  for (const policy of policies) {
    const group = String(policy.metadata?.campaignGroup ?? "");
    const key = group || policy.id;
    const current = result.get(key);
    if (!current || (policy.nextFireAt?.getTime() ?? Infinity) < (current.nextFireAt?.getTime() ?? Infinity)) {
      result.set(key, policy);
    }
  }
  return [...result.values()];
}
