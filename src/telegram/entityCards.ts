import { DateTime } from "luxon";

import {
  campaignCardKeyboard,
  itemMenuKeyboard,
  reminderPolicyCardKeyboard,
} from "@/bot/keyboards";
import { getPlannerItemById, listCampaignItems } from "@/db/queries/items";
import {
  getReminderPolicyById,
  listReminderPoliciesForCampaign,
  listReminderPoliciesForItem,
} from "@/db/queries/reminderPolicies";
import type { EntityRef } from "@/domain/entityRefs";
import { importanceLabel, importanceMode, urgencyExplanation } from "@/domain/importance";
import {
  getBasePriority,
  getEffectivePriority,
  getUrgencyBoost,
} from "@/domain/timelineClassification";
import { getItemGoogleSyncState } from "@/db/queries/googleCalendar";
import { safeCalendarErrorClass } from "@/services/calendarDiagnostics";

export async function renderEntityCard(params: {
  userId: string;
  timezone: string;
  ref: EntityRef;
  now?: Date;
}) {
  if (params.ref.type === "reminder_policy") return renderPolicyCard(params);
  if (params.ref.type === "campaign") return renderCampaignCard(params);
  return renderItemCard(params);
}

async function renderItemCard(params: {
  userId: string;
  timezone: string;
  ref: EntityRef;
  now?: Date;
}) {
  const item = await getPlannerItemById(params.userId, params.ref.id);
  if (!item) return null;
  const now = params.now ?? new Date();
  const [policies, calendar] = await Promise.all([
    listReminderPoliciesForItem(params.userId, item.id),
    getItemGoogleSyncState(item.id),
  ]);
  const base = getBasePriority({ item });
  const effective = getEffectivePriority({ item }, now, params.timezone);
  const boost = getUrgencyBoost({ item }, now, params.timezone);
  const when = item.startAt ?? item.dueAt;
  const campaignGroup = String(item.metadata?.campaignGroup ?? "");
  return {
    text: [
      item.title,
      "",
      `Статус: ${item.status}`,
      `Тип: ${item.kind}`,
      `Когда: ${formatDate(when, item.timezone) || "без времени"}`,
      `Важность: ${importanceLabel(base)} (${importanceMode({ item })})`,
      `Сейчас: ${importanceLabel(effective)}; ${urgencyExplanation(boost)}`,
      `Напоминания: ${policies.filter((policy) => policy.status === "active").length}`,
      ["event", "training", "tentative_event"].includes(item.kind)
        ? `Календарь: ${formatCalendarState(calendar?.status, safeCalendarErrorClass(calendar?.lastError))}`
        : null,
      campaignGroup ? `Кампания: ${campaignGroup}` : null,
      item.category === "health" || item.metadata?.familyRelated === true
        ? "Рекомендация: добавить напоминание заранее."
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
    keyboard: itemMenuKeyboard(
      item.id,
      campaignGroup || null,
      ["event", "training", "tentative_event"].includes(item.kind),
    ),
  };
}

function formatCalendarState(status?: string | null, errorClass?: string | null) {
  if (status === "synced") return "synced";
  if (status === "pending_retry") return `${errorClass ?? "pending retry"}, повторю автоматически`;
  if (status === "failed" || status === "error") return `failed (${errorClass ?? "unknown"})`;
  if (status === "pending" || status === "not_synced" || status === "syncing") return status;
  if (status === "disabled") return "disabled";
  return "unknown";
}

async function renderPolicyCard(params: {
  userId: string;
  timezone: string;
  ref: EntityRef;
  now?: Date;
}) {
  const policy = await getReminderPolicyById(params.ref.id);
  if (!policy || policy.userId !== params.userId) return null;
  return {
    text: [
      policy.title,
      "",
      `Статус: ${policy.status}`,
      `Тип: ${policy.policyType}`,
      `Важность: ${importanceLabel(getBasePriority({ policy }))}`,
      `Следующее: ${formatDate(policy.nextFireAt, policy.timezone) || "нет"}`,
      `Окно: ${formatDate(policy.startsAt, policy.timezone) || "без начала"} - ${formatDate(policy.endsAt, policy.timezone) || "без конца"}`,
      `Категория: ${policy.category}`,
    ].join("\n"),
    keyboard: reminderPolicyCardKeyboard(policy),
  };
}

async function renderCampaignCard(params: {
  userId: string;
  timezone: string;
  ref: EntityRef;
  now?: Date;
}) {
  const [items, policies] = await Promise.all([
    listCampaignItems(params.userId, params.ref.id),
    listReminderPoliciesForCampaign(params.userId, params.ref.id),
  ]);
  if (!items.length && !policies.length) return null;
  const active = items.find((item) => item.metadata?.campaignState === "active");
  const next = items.find((item) => item.metadata?.campaignState === "waiting");
  return {
    text: [
      `Кампания: ${params.ref.id}`,
      "",
      `Статус: ${active ? "активна" : "ожидает"}`,
      `Ближайшее: ${active?.title ?? next?.title ?? "нет"}`,
      `Следующее: ${next?.title ?? "нет"}`,
      `Элементов: ${items.length}`,
      `Политик: ${policies.filter((policy) => policy.status === "active").length}`,
    ].join("\n"),
    keyboard: campaignCardKeyboard(params.ref.id),
  };
}

function formatDate(value: Date | null, timezone: string) {
  return value
    ? DateTime.fromJSDate(value, { zone: "utc" }).setZone(timezone).toFormat("dd.LL.yyyy HH:mm")
    : null;
}
