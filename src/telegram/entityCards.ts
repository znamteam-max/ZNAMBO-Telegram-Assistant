import { DateTime } from "luxon";

import {
  campaignCardKeyboard,
  externalCalendarEventKeyboard,
  itemMenuKeyboard,
  reminderPolicyCardKeyboard,
} from "@/bot/keyboards";
import { getPlannerItemById, listCampaignItems } from "@/db/queries/items";
import { getExternalCalendarEventById } from "@/db/queries/externalCalendarEvents";
import {
  getReminderPolicyById,
  listReminderPoliciesForCampaign,
  listReminderPoliciesForItem,
} from "@/db/queries/reminderPolicies";
import type { EntityRef } from "@/domain/entityRefs";
import { importanceLabel, urgencyExplanation, visibleImportanceLabel } from "@/domain/importance";
import {
  getBasePriority,
  getEffectivePriority,
  getUrgencyBoost,
} from "@/domain/timelineClassification";
import { getItemCalendarSyncState } from "@/db/queries/googleCalendar";
import { safeCalendarErrorClass } from "@/services/calendarDiagnostics";
import { getCalendarProvider } from "@/lib/env";

const itemKindLabels: Record<string, string> = {
  event: "встреча",
  task: "задача",
  training: "тренировка",
  note: "заметка",
  preparation_task: "подготовка",
  tentative_event: "предварительное событие",
  recurring_task: "повторяющаяся задача",
};

export async function renderEntityCard(params: {
  userId: string;
  timezone: string;
  ref: EntityRef;
  now?: Date;
}) {
  if (params.ref.type === "reminder_policy") return renderPolicyCard(params);
  if (params.ref.type === "campaign") return renderCampaignCard(params);
  if (params.ref.type === "external_calendar_event") return renderExternalCalendarEventCard(params);
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
  const calendarProvider = getCalendarProvider();
  const [policies, calendar] = await Promise.all([
    listReminderPoliciesForItem(params.userId, item.id),
    getItemCalendarSyncState(
      item.id,
      calendarProvider === "yandex" ? "yandex_calendar" : "google_calendar",
    ),
  ]);
  const effective = getEffectivePriority({ item }, now, params.timezone);
  const boost = getUrgencyBoost({ item }, now, params.timezone);
  const when = item.startAt ?? item.dueAt;
  const campaignGroup = String(item.metadata?.campaignGroup ?? "");
  return {
    text: [
      item.title,
      "",
      `Статус: ${item.status}`,
      `Тип: ${itemKindLabels[item.kind] ?? item.kind}`,
      `Когда: ${formatDate(when, item.timezone) || "без времени"}`,
      `Важность: ${visibleImportanceLabel({ item })}`,
      `Сейчас: ${importanceLabel(effective)}; ${urgencyExplanation(boost)}`,
      `Напоминания: ${policies.filter((policy) => policy.status === "active").length}`,
      ["event", "training", "tentative_event"].includes(item.kind)
        ? `Календарь: ${formatCalendarState(calendar?.status, safeCalendarErrorClass(calendar?.lastError), calendar?.provider)}`
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
      calendar?.status ?? null,
    ),
  };
}

async function renderExternalCalendarEventCard(params: {
  userId: string;
  timezone: string;
  ref: EntityRef;
}) {
  const event = await getExternalCalendarEventById(params.userId, params.ref.id);
  if (!event) return null;
  return {
    text: [
      event.summary,
      "",
      "Статус: external synced",
      `Когда: ${formatDate(event.startAt, event.timezone)}${event.endAt ? `–${DateTime.fromJSDate(event.endAt, { zone: "utc" }).setZone(event.timezone).toFormat("HH:mm")}` : ""}`,
      event.location ? `Место: ${event.location}` : null,
      `Календарь: Яндекс · ${event.calendarLabel} · external`,
      "Источник: создано в Яндекс.Календаре",
      event.isRecurring ? "Повторение: серия событий" : null,
    ]
      .filter(Boolean)
      .join("\n"),
    keyboard: externalCalendarEventKeyboard(event.id, event.isRecurring),
  };
}

function formatCalendarState(
  status?: string | null,
  errorClass?: string | null,
  syncProvider?: string | null,
) {
  const provider = syncProvider?.includes("yandex") || getCalendarProvider() === "yandex"
    ? "Яндекс"
    : syncProvider?.includes("google") || getCalendarProvider() === "google"
      ? "Google"
      : "не подключён";
  const prefix = `${provider} · Личный · `;
  if (status === "synced") return `${prefix}synced`;
  if (status === "pending_retry") return `${prefix}${errorClass ?? "pending retry"}, повторю автоматически`;
  if (status === "failed" || status === "error") return `failed (${errorClass ?? "unknown"})`;
  if (status === "pending" || status === "not_synced" || status === "syncing") return `${prefix}${status}`;
  if (status === "disabled") return `${prefix}disabled`;
  return `${prefix}unknown`;
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
