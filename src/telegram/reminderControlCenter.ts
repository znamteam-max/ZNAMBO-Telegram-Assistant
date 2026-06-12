import { DateTime } from "luxon";

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
  reminderPolicyCardKeyboard,
} from "@/bot/keyboards";
import { buildUserTimelineView } from "@/services/userTimeline";

export async function renderReminderControlCenter(params: {
  userId: string;
  timezone: string;
  scope?: string | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const scope = params.scope?.toLowerCase() || "active";
  const policies =
    scope === "paused"
      ? await listReminderPoliciesByStatus(params.userId, "paused", 100)
      : (await buildUserTimelineView(params)).policies;
  const filtered = groupCampaignPolicies(policies)
    .filter((policy) => policyMatchesScope(policy, scope, now, params.timezone))
    .sort((a, b) =>
      compareTimelineEntries({ policy: a }, { policy: b }, now, params.timezone),
    );
  const title = scope === "paused" ? "Напоминания на паузе" : "Центр напоминаний";
  const lines = [
    title,
    "",
    ...(filtered.length
      ? filtered.map(
          (policy, index) =>
            `${index + 1}. ${formatPolicyLine(policy, now, params.timezone)}`,
        )
      : ["Подходящих политик нет."]),
  ];
  return {
    text: lines.join("\n"),
    policies: filtered,
    keyboard: entityListKeyboard(
      filtered.map((policy) => {
        const campaignGroup = String(policy.metadata?.campaignGroup ?? "");
        return campaignGroup
          ? { type: "campaign" as const, id: campaignGroup }
          : { type: "reminder_policy" as const, id: policy.id };
      }),
    ),
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
    ? DateTime.fromJSDate(policy.nextFireAt, { zone: "utc" })
        .setZone(policy.timezone || params.timezone)
        .toFormat("dd.LL.yyyy HH:mm")
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
      `Тип: ${policy.policyType}`,
      `Важность: ${importanceLabel(getBasePriority({ policy }))}`,
      `Сейчас: ${importanceLabel(getEffectivePriority({ policy }, now, params.timezone))}; ${urgencyExplanation(getUrgencyBoost({ policy }, now, params.timezone))}`,
      `Частота: ${policy.intervalMinutes ? `каждые ${policy.intervalMinutes} мин` : policy.recurrenceRule ?? "один раз"}`,
      `Окно: ${window || "без ограничений"}`,
      `До выполнения: ${policy.requireAck ? "да" : "нет"}`,
      `Следующее: ${next}`,
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
  const next = policy.nextFireAt
    ? DateTime.fromJSDate(policy.nextFireAt, { zone: "utc" })
        .setZone(policy.timezone || timezone)
        .toFormat("dd.LL HH:mm")
    : "нет следующего";
  const marker = importanceMarker(getBasePriority({ policy }));
  return `${marker ? `${marker} · ` : ""}${policy.title}\n   ${policy.policyType} · ${next}`;
}

function formatDate(value: Date | null, timezone: string) {
  return value
    ? DateTime.fromJSDate(value, { zone: "utc" }).setZone(timezone).toFormat("dd.LL HH:mm")
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
