import { DateTime } from "luxon";

import {
  campaignCardKeyboard,
  completedItemKeyboard,
  externalCalendarEventKeyboard,
  itemMenuKeyboard,
  pastReviewItemKeyboard,
  reminderPolicyCardKeyboard,
} from "@/bot/keyboards";
import { getPlannerItemById, listCampaignItems } from "@/db/queries/items";
import { getExternalCalendarEventById } from "@/db/queries/externalCalendarEvents";
import {
  getReminderPolicyById,
  listReminderPoliciesForCampaign,
  listReminderPoliciesForItem,
} from "@/db/queries/reminderPolicies";
import type { PlannerItem } from "@/db/schema";
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
import { formatRuWeekdayDateTime } from "@/domain/dateTime";
import {
  formatHumanReminderPolicy,
  formatItemReminderPolicyLines,
} from "@/domain/reminderPolicyPresentation";
import { formatDeadlineDateTime } from "@/domain/deadlineSemantics";

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
  const campaignGroup = String(item.metadata?.campaignGroup ?? "");
  const activePolicies = policies.filter((policy) => policy.status === "active");
  const beforeEventPolicies = activePolicies
    .filter((policy) => policy.policyType === "before_event")
    .sort(
      (left, right) =>
        Number(right.metadata?.minutesBefore ?? 0) - Number(left.metadata?.minutesBefore ?? 0),
    );
  const displayPolicies = [
    ...beforeEventPolicies,
    ...activePolicies.filter((policy) => policy.policyType !== "before_event"),
  ];
  const reminderLines = formatItemReminderPolicyLines(displayPolicies, item.timezone, {
    item,
    now,
    includeNextBeforeEvent: true,
  });
  return {
    text: [
      item.title,
      "",
      `Статус: ${item.status}`,
      item.status === "completed" && item.completedAt
        ? `Выполнено: ${formatRuWeekdayDateTime(item.completedAt, item.timezone, {
            includeYear: true,
          })}`
        : null,
      `Тип: ${itemKindLabels[item.kind] ?? item.kind}`,
      ...formatItemTimingLines(item),
      `Важность: ${visibleImportanceLabel({ item })}`,
      `Сейчас: ${importanceLabel(effective)}; ${urgencyExplanation(boost)}`,
      ...(reminderLines.length
        ? ["Напоминания:", ...reminderLines.map((line, index) => `${index + 1}. ${line}`)]
        : ["Напоминания: нет"]),
      item.snoozedUntil && item.snoozedUntil > now
        ? `Отложено до: ${formatRuWeekdayDateTime(item.snoozedUntil, item.timezone)}`
        : null,
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
    keyboard:
      item.status === "completed"
        ? completedItemKeyboard(item.id)
        : isPastReviewCard(item, now)
          ? pastReviewItemKeyboard(item.id)
          : itemMenuKeyboard(
              item.id,
              campaignGroup || null,
              calendar?.status ?? null,
              Boolean(item.dueAt && !item.startAt),
              beforeEventPolicies,
            ),
  };
}

function isPastReviewCard(item: PlannerItem, now: Date) {
  if (item.status !== "active") return false;
  if (!["event", "training", "tentative_event"].includes(item.kind)) return false;
  const override = item.metadata?.pastReviewOverride;
  if (
    override &&
    typeof override === "object" &&
    (override as Record<string, unknown>).keepInPlan === true
  ) {
    return false;
  }
  const endedAt =
    item.endAt ?? (item.startAt ? new Date(item.startAt.getTime() + 60 * 60_000) : null);
  if (!endedAt || endedAt > now) return false;
  return (
    item.priority >= 4 ||
    item.metadata?.important === true ||
    Number(item.metadata?.basePriority ?? 0) >= 4
  );
}

export function formatItemTimingLines(item: PlannerItem) {
  return [
    item.startAt
      ? `Когда делать: ${formatDate(item.startAt, item.timezone)}${item.endAt ? `–${DateTime.fromJSDate(item.endAt, { zone: "utc" }).setZone(item.timezone).toFormat("HH:mm")}` : ""}`
      : "Запланированное время: нет",
    item.dueAt ? `Дедлайн: ${formatDeadlineDateTime(item.dueAt, item.timezone, true)}` : null,
  ].filter((line): line is string => Boolean(line));
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
  const provider =
    syncProvider?.includes("yandex") || getCalendarProvider() === "yandex"
      ? "Яндекс"
      : syncProvider?.includes("google") || getCalendarProvider() === "google"
        ? "Google"
        : "не подключён";
  const prefix = `${provider} · Личный · `;
  if (status === "synced") return `${prefix}synced`;
  if (status === "pending_retry")
    return `${prefix}${errorClass ?? "pending retry"}, повторю автоматически`;
  if (status === "failed" || status === "error") return `failed (${errorClass ?? "unknown"})`;
  if (status === "pending" || status === "not_synced" || status === "syncing")
    return `${prefix}${status}`;
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
      `Напоминания: ${formatHumanReminderPolicy(policy, policy.timezone, {
        includeNext: true,
        includeMarker: false,
      })}`,
      `Важность: ${importanceLabel(getBasePriority({ policy }))}`,
      policy.snoozedUntil && policy.snoozedUntil > (params.now ?? new Date())
        ? `Отложено до: ${formatRuWeekdayDateTime(policy.snoozedUntil, policy.timezone)}`
        : null,
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
  return value ? formatRuWeekdayDateTime(value, timezone, { includeYear: true }) : null;
}
