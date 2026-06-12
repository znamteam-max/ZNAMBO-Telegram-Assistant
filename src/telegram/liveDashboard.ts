import { DateTime } from "luxon";

import {
  createActiveDashboard,
  getActiveDashboard,
  markDashboardStatus,
} from "@/db/queries/liveDashboards";
import { listLegacyReminderLikeItems } from "@/db/queries/items";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { logger } from "@/lib/logger";
import {
  classifyTimelineItem,
  compareTimelineEntries,
  getBasePriority,
} from "@/domain/timelineClassification";
import { importanceMarker } from "@/domain/importance";
import type { EntityRef } from "@/domain/entityRefs";
import { buildUserTimelineView } from "@/services/userTimeline";
import { listCalendarSyncStatesForUser } from "@/db/queries/googleCalendar";
import { formatRuItemsRequireDecision } from "@/lib/ruPlural";
import { rememberTaskView } from "@/agent/state/taskViewState";
import { detectPlanConflicts, formatConflictLine } from "@/services/planConflicts";

import { getBot } from "@/bot/createBot";
import { entityListKeyboard } from "@/bot/keyboards";
import { deleteMessageSafe, registerBotMessage, removeKeyboardSafe } from "./messageLifecycle";

export type LiveDashboardTelegramApi = {
  sendMessage(
    chatId: string,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  deleteMessage(chatId: string, messageId: number): Promise<unknown>;
  editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    options: { reply_markup: { inline_keyboard: never[] } },
  ): Promise<unknown>;
  editMessageText?(
    chatId: string,
    messageId: number,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
};

export async function renderLiveDashboard(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(params.timezone).setLocale("ru");
  const weekEnd = local.plus({ days: 7 }).endOf("day").toUTC().toJSDate();
  const [timeline, calendarStates] = await Promise.all([
    buildUserTimelineView(params),
    listCalendarSyncStatesForUser(params.userId, 100),
  ]);
  const calendarByItemId = new Map<string, (typeof calendarStates)[number]["sync"]>();
  for (const { sync } of calendarStates) {
    if (!calendarByItemId.has(sync.plannerItemId)) calendarByItemId.set(sync.plannerItemId, sync);
  }
  const itemRows = timeline.rows.filter(
    (row) => row.item && !["history", "hidden"].includes(row.dateBucket),
  );
  const allItems = itemRows.map((row) => row.item!);
  const todayItems = itemRows
    .filter((row) => row.dateBucket === "today")
    .map((row) => row.item!)
    .slice(0, 8);
  const tomorrowItems = itemRows
    .filter((row) => row.dateBucket === "tomorrow")
    .map((row) => row.item!)
    .slice(0, 8);
  const soonItems = itemRows
    .filter((row) => {
      if (row.dateBucket !== "soon") return false;
      const anchor = row.item?.startAt ?? row.item?.dueAt;
      return Boolean(anchor && anchor <= weekEnd);
    })
    .map((row) => row.item!)
    .slice(0, 10);
  const scheduledIds = new Set(
    [...todayItems, ...tomorrowItems, ...soonItems].map((item) => item.id),
  );
  const importantItems = allItems
    .filter((item) => !scheduledIds.has(item.id) && getBasePriority({ item }) >= 4)
    .slice(0, 5);
  const longTermItems = itemRows
    .filter(
      (row) =>
        (row.dateBucket === "long_term" ||
          Boolean((row.item?.startAt ?? row.item?.dueAt) && (row.item?.startAt ?? row.item?.dueAt)! > weekEnd)) &&
        row.item &&
        !importantItems.some((item) => item.id === row.item!.id),
    )
    .map((row) => row.item!)
    .slice(0, 5);
  const unresolvedItems = timeline.byBucket.unresolvedPast
    .filter((row) => row.item)
    .map((row) => row.item!)
    .slice(0, 5);
  const conflicts = detectPlanConflicts(allItems);
  const displayPolicies = timeline.policies;
  const nagging = displayPolicies
    .filter((policy) => classifyTimelineItem({ policy }, now, params.timezone) === "active_nag")
    .sort((a, b) =>
      compareTimelineEntries({ policy: a }, { policy: b }, now, params.timezone),
    )
    .slice(0, 5);
  const naggingIds = new Set(nagging.map((policy) => policy.id));
  const soon = displayPolicies
    .filter(
      (policy) =>
        !naggingIds.has(policy.id) &&
        classifyTimelineItem({ policy }, now, params.timezone) === "soon",
    )
    .sort((a, b) =>
      compareTimelineEntries({ policy: a }, { policy: b }, now, params.timezone),
    )
    .slice(0, 5);
  const soonIds = new Set(soon.map((policy) => policy.id));
  const campaigns = displayPolicies
    .filter((policy) => Boolean(policy.metadata?.campaignGroup))
    .sort((a, b) => compareTimelineEntries({ policy: a }, { policy: b }, now, params.timezone))
    .slice(0, 4);
  const campaignIds = new Set(campaigns.map((policy) => policy.id));
  const distant = displayPolicies
    .filter((policy) => {
      if (naggingIds.has(policy.id) || soonIds.has(policy.id) || campaignIds.has(policy.id)) return false;
      return (
        classifyTimelineItem({ policy }, now, params.timezone) === "distant_priority" &&
        getBasePriority({ policy }) >= 4
      );
    })
    .sort((a, b) =>
      compareTimelineEntries({ policy: a }, { policy: b }, now, params.timezone),
    )
    .slice(0, 4);
  const longTerm = displayPolicies
    .filter(
      (policy) =>
        !campaignIds.has(policy.id) &&
        classifyTimelineItem({ policy }, now, params.timezone) === "long_term",
    )
    .sort((a, b) => compareTimelineEntries({ policy: a }, { policy: b }, now, params.timezone))
    .slice(0, 4);

  const lines = ["JARVIS · План"];
  const refs: EntityRef[] = [];
  const orderedItems: PlannerItem[] = [];
  let displayIndex = 1;
  const pushRows = (rows: Array<{ text: string; ref: EntityRef; item?: PlannerItem }>) => {
    for (const row of rows) {
      lines.push(`${displayIndex}. ${row.text}`);
      refs.push(row.ref);
      if (row.item) orderedItems.push(row.item);
      displayIndex += 1;
    }
  };
  const itemRowsFor = (items: PlannerItem[], includeDate = false) =>
    items.map((item) => ({
      text: formatDashboardItem(
        item,
        params.timezone,
        calendarByItemId.get(item.id),
        includeDate,
      ),
      ref: { type: "planner_item" as const, id: item.id },
      item,
    }));

  lines.push("", "Сегодня:");
  if (todayItems.length) {
    pushRows(itemRowsFor(todayItems));
  } else {
    lines.push("На сегодня нет событий.");
  }
  if (tomorrowItems.length) {
    lines.push("", "Завтра:");
    pushRows(itemRowsFor(tomorrowItems));
  }
  if (soonItems.length) {
    lines.push("", "Скоро:");
    pushRows(itemRowsFor(soonItems, true));
  }
  if (conflicts.length) {
    lines.push("", "Конфликты:");
    lines.push(...conflicts.slice(0, 5).map((conflict) => formatConflictLine(conflict, params.timezone)));
  }
  if (importantItems.length) {
    lines.push("", "Важное:");
    pushRows(itemRowsFor(importantItems, true));
  }
  if (longTermItems.length) {
    lines.push("", "Долгосрочные:");
    pushRows(itemRowsFor(longTermItems, true));
  }
  if (unresolvedItems.length) {
    lines.push("", "Неразобранное:");
    pushRows(itemRowsFor(unresolvedItems, true));
    lines.push(formatRuItemsRequireDecision(unresolvedItems.length));
  }
  if (nagging.length) {
    lines.push("", "Активные напоминания:");
    pushRows(nagging.map((policy) => policyRow(policy, params.timezone)));
  }
  if (soon.length) {
    lines.push("", "Ближайшие правила:");
    pushRows(soon.map((policy) => policyRow(policy, params.timezone)));
  }
  if (campaigns.length) {
    lines.push("", "Кампании:");
    pushRows(campaigns.map((policy) => policyRow(policy, params.timezone)));
  }
  if (distant.length) {
    lines.push("", "Важные правила:");
    pushRows(distant.map((policy) => policyRow(policy, params.timezone)));
  }
  if (longTerm.length) {
    lines.push("", "Долгосрочные правила:");
    pushRows(longTerm.map((policy) => policyRow(policy, params.timezone)));
  }

  if (!orderedItems.length && allItems.length) {
    const fallback = allItems.slice(0, 8);
    lines.push("", "Открытые записи:");
    pushRows(itemRowsFor(fallback, true));
  }

  const viewState = await rememberTaskView({
    userId: params.userId,
    scope: "dashboard",
    title: "JARVIS · План",
    items: orderedItems,
    metadata: { source: "live_dashboard", conflictCount: conflicts.length },
  });

  return {
    text: lines.join("\n"),
    items: orderedItems,
    policies: displayPolicies,
    keyboard: entityListKeyboard(refs, true),
    viewState,
    conflicts,
  };
}
export async function renderReminderPolicyList(params: {
  userId: string;
  timezone: string;
  longTermOnly?: boolean;
  category?: string | null;
}) {
  const [timeline, legacyAll] = await Promise.all([
    buildUserTimelineView({ userId: params.userId, timezone: params.timezone }),
    listLegacyReminderLikeItems(params.userId, 50),
  ]);
  const policies = timeline.policies.filter((policy) => {
    if (params.category) {
      return policy.category === params.category || policy.category === `recurring_${params.category}`;
    }
    if (params.longTermOnly) {
      return classifyTimelineItem({ policy }, new Date(), params.timezone) === "long_term";
    }
    return true;
  });
  const legacy = params.longTermOnly
    ? legacyAll.filter(
        (item) =>
          item.visibility === "long_term" ||
          /(зеркал|жкх|регулярное\s+напоминание)/i.test(item.title),
      )
    : legacyAll;
  const title = params.longTermOnly ? "Дальние и регулярные напоминания" : "Активные напоминания";
  return [
    title,
    "",
    ...(policies.length
      ? policies.map((policy, index) => `${index + 1}. ${formatPolicy(policy, params.timezone)}`)
      : ["Активные политики: 0"]),
    ...(legacy.length
      ? [
          "",
          `Нашёл ${legacy.length} старых записей, похожих на напоминания, но без policy:`,
          ...legacy.map((item, index) => `${index + 1}. ${item.title}`),
          "",
          "Они не считаются работающими регулярными напоминаниями до конвертации.",
        ]
      : []),
  ].join("\n");
}

export async function sendOrRefreshLiveDashboard(params: {
  userId: string;
  chatId: string;
  timezone: string;
  now?: Date;
  api?: LiveDashboardTelegramApi;
}) {
  const api = params.api ?? (getBot().api as unknown as LiveDashboardTelegramApi);
  const previous = await getActiveDashboard(params.userId, params.chatId);
  if (previous) {
    try {
      const deleted = await deleteMessageSafe({
        chatId: params.chatId,
        messageId: previous.messageId,
        api,
      });
      await markDashboardStatus(previous.id, deleted ? "deleted" : "failed_to_delete");
      if (!deleted && api.editMessageText && typeof previous.payload?.text === "string") {
        await api
          .editMessageText(
            params.chatId,
            previous.messageId,
            `Устарело\n\n${previous.payload.text}`,
            {
              reply_markup: { inline_keyboard: [] },
            },
          )
          .catch(() => undefined);
      }
    } catch (error) {
      await removeKeyboardSafe({
        chatId: params.chatId,
        messageId: previous.messageId,
        api,
      });
      await markDashboardStatus(previous.id, "failed_to_delete");
      logger.warn("Old dashboard could not be deleted", {
        dashboardId: previous.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const rendered = await renderLiveDashboard(params);
  const sent = await api.sendMessage(params.chatId, rendered.text, {
    reply_markup: rendered.keyboard,
  });
  const dashboard = await createActiveDashboard({
    userId: params.userId,
    chatId: params.chatId,
    messageId: sent.message_id,
    payload: {
      text: rendered.text,
      itemIds: rendered.items.map((item) => item.id),
      policyIds: rendered.policies.map((policy) => policy.id),
    },
  });
  await registerBotMessage({
    userId: params.userId,
    chatId: params.chatId,
    messageId: sent.message_id,
    purpose: "dashboard",
    metadata: { dashboardId: dashboard.id },
  });
  return { dashboard, ...rendered };
}

export async function refreshDashboardAfterMutation(params: {
  userId: string;
  chatId: string | number;
  timezone: string;
  now?: Date;
  api?: LiveDashboardTelegramApi;
}) {
  return sendOrRefreshLiveDashboard({
    ...params,
    chatId: String(params.chatId),
  });
}

function formatDashboardItem(
  item: PlannerItem,
  timezone: string,
  calendar?: { status: string; lastError: string | null } | null,
  includeDate = false,
) {
  if (item.status === "completed") return `✅ ${item.title} — завершено`;
  const start = item.startAt ?? item.dueAt;
  const time = start
    ? DateTime.fromJSDate(start, { zone: "utc" })
        .setZone(item.timezone || timezone)
        .toFormat(includeDate ? "dd.LL HH:mm" : "HH:mm")
    : "без времени";
  const end = item.endAt
    ? DateTime.fromJSDate(item.endAt, { zone: "utc" })
        .setZone(item.timezone || timezone)
        .toFormat("HH:mm")
    : null;
  const marker = item.kind === "training" ? "🟢" : item.kind === "preparation_task" ? "🟡" : "🔴";
  const important = importanceMarker(getBasePriority({ item })).split(" ")[0];
  const calendarStatus =
    ["event", "training", "tentative_event"].includes(item.kind) &&
    ["pending_retry", "failed", "error"].includes(calendar?.status ?? "")
      ? ` · Календарь: ${calendar?.lastError ?? calendar?.status}, повторю автоматически`
      : "";
  return `${time}${end ? `–${end}` : ""} · ${important ? `${important} ` : ""}${marker} ${item.title}${calendarStatus}`;
}

function formatPolicy(policy: ReminderPolicy, timezone: string) {
  const next = policy.nextFireAt
    ? DateTime.fromJSDate(policy.nextFireAt, { zone: "utc" })
        .setZone(policy.timezone || timezone)
        .toFormat("dd.LL HH:mm")
    : "без ближайшего запуска";
  const priorityLabel = importanceMarker(getBasePriority({ policy })).split(" ")[0];
  if (policy.policyType === "interval_window") {
    return `${priorityLabel ? `${priorityLabel} · ` : ""}${policy.title}: каждые ${policy.intervalMinutes ?? "?"} мин, следующее ${next}`;
  }
  return `${priorityLabel ? `${priorityLabel} · ` : ""}${policy.title} — ${next}`;
}

function policyRow(policy: ReminderPolicy, timezone: string): { text: string; ref: EntityRef } {
  const campaignGroup = String(policy.metadata?.campaignGroup ?? "");
  return {
    text: formatPolicy(policy, timezone),
    ref: campaignGroup
      ? { type: "campaign", id: campaignGroup }
      : { type: "reminder_policy", id: policy.id },
  };
}
