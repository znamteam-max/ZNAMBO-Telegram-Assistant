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
  getBasePriority,
} from "@/domain/timelineClassification";
import { importanceMarker, visibleImportanceMarker } from "@/domain/importance";
import type { EntityRef } from "@/domain/entityRefs";
import { buildUserTimelineView } from "@/services/userTimeline";
import { listCalendarSyncStatesForUser } from "@/db/queries/googleCalendar";
import { formatRuItemsRequireDecision } from "@/lib/ruPlural";
import { rememberTaskView } from "@/agent/state/taskViewState";
import { detectPlanConflicts, formatConflictLine } from "@/services/planConflicts";
import { reconcileActiveReminderPolicies } from "@/services/reminderPolicyReconciler";
import {
  formatHumanReminderPolicy,
  isPersistentReminderPolicy,
} from "@/domain/reminderPolicyPresentation";
import { shouldShowPersistentMarker } from "@/domain/persistentMarker";
import { formatRuWeekdayDateTime } from "@/domain/dateTime";
import { formatDeadlineDateTime } from "@/domain/deadlineSemantics";

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
  await reconcileActiveReminderPolicies({ now, limit: 200 }).catch((error) => {
    logger.warn("Dashboard reminder reconciliation failed without blocking view", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
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
  const isPastActiveItem = (item: PlannerItem) => {
    const anchor = item.endAt ?? item.startAt ?? item.dueAt;
    return Boolean(anchor && anchor <= now && item.status === "active");
  };
  const pastTodayItems = itemRows
    .filter((row) => row.dateBucket === "today" && row.item && isPastActiveItem(row.item))
    .map((row) => row.item!)
    .slice(0, 5);
  const pastTodayIds = new Set(pastTodayItems.map((item) => item.id));
  const currentItems = itemRows
    .filter((row) => row.classification === "now" && row.item)
    .map((row) => row.item!)
    .slice(0, 5);
  const currentIds = new Set(currentItems.map((item) => item.id));
  const todayItems = itemRows
    .filter(
      (row) =>
        row.dateBucket === "today" &&
        row.item &&
        !pastTodayIds.has(row.item.id) &&
        !currentIds.has(row.item.id),
    )
    .map((row) => row.item!)
    .sort(compareDashboardItems)
    .slice(0, 8);
  const tomorrowItems = itemRows
    .filter((row) => row.dateBucket === "tomorrow")
    .map((row) => row.item!)
    .sort(compareDashboardItems)
    .slice(0, 8);
  const soonItems = itemRows
    .filter((row) => {
      if (row.dateBucket !== "soon") return false;
      const anchor = row.item?.startAt ?? row.item?.dueAt;
      return Boolean(anchor && anchor > now && anchor <= weekEnd);
    })
    .map((row) => row.item!)
    .sort(compareDashboardItems)
    .slice(0, 10);
  const scheduledIds = new Set(
    [...currentItems, ...todayItems, ...tomorrowItems, ...soonItems].map((item) => item.id),
  );
  const importantItems = allItems
    .filter(
      (item) => !scheduledIds.has(item.id) && !pastTodayIds.has(item.id) && getBasePriority({ item }) >= 4,
    )
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
  const unresolvedItems = [
    ...pastTodayItems,
    ...timeline.byBucket.unresolvedPast
    .filter((row) => row.item)
    .map((row) => row.item!)
    .filter((item) => !pastTodayIds.has(item.id)),
  ].slice(0, 5);
  const conflicts = detectPlanConflicts(allItems, { now });
  const displayPolicies = timeline.policies.filter(
    (policy) => policy.metadata?.hiddenFromDashboard !== true,
  );
  const policiesByItemId = new Map<string, ReminderPolicy[]>();
  for (const policy of displayPolicies) {
    if (!policy.itemId) continue;
    policiesByItemId.set(policy.itemId, [...(policiesByItemId.get(policy.itemId) ?? []), policy]);
  }
  const unattachedPolicies = displayPolicies
    .filter((policy) => !policy.itemId && policy.metadata?.needsReview !== true)
    .slice(0, 5);

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
        policiesByItemId.get(item.id) ?? [],
        now,
      ),
      ref: {
        type:
          item.source === "yandex_external"
            ? ("external_calendar_event" as const)
            : ("planner_item" as const),
        id: item.id,
      },
      item,
    }));

  if (currentItems.length) {
    lines.push("", "Сейчас / идёт:");
    pushRows(itemRowsFor(currentItems));
  }
  lines.push("", currentItems.length ? "Сегодня позже:" : "Сегодня:");
  if (todayItems.length) {
    pushRows(itemRowsFor(todayItems));
  } else {
    lines.push(
      currentItems.length
        ? "Больше событий сегодня нет."
        : "На сегодня нет событий.",
    );
  }
  if (tomorrowItems.length) {
    lines.push("", "Завтра:");
    pushRows(itemRowsFor(tomorrowItems, true));
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
  if (unattachedPolicies.length) {
    lines.push("", "Неразобранные напоминания:");
    pushRows(unattachedPolicies.map((policy) => policyRow(policy, params.timezone)));
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
  await reconcileActiveReminderPolicies({ limit: 200 }).catch((error) => {
    logger.warn("Reminder list reconciliation failed without blocking view", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
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

export function formatDashboardItem(
  item: PlannerItem,
  timezone: string,
  calendar?: { status: string; lastError: string | null } | null,
  includeDate = false,
  policies: ReminderPolicy[] = [],
  now = new Date(),
) {
  if (item.status === "completed") return `✅ ${item.title} — завершено`;
  const time = item.startAt
    ? includeDate
      ? formatRuWeekdayDateTime(item.startAt, item.timezone || timezone)
      : DateTime.fromJSDate(item.startAt, { zone: "utc" }).setZone(item.timezone || timezone).toFormat("HH:mm")
    : item.dueAt
      ? includeDate
        ? formatDeadlineDateTime(item.dueAt, item.timezone || timezone)
        : `до ${DateTime.fromJSDate(item.dueAt, { zone: "utc" }).setZone(item.timezone || timezone).toFormat("HH:mm")}`
      : null;
  const end = item.endAt
    ? DateTime.fromJSDate(item.endAt, { zone: "utc" })
        .setZone(item.timezone || timezone)
        .toFormat("HH:mm")
    : null;
  const important =
    item.source === "yandex_external" ? "" : visibleImportanceMarker({ item }).split(" ")[0];
  const persistent = shouldShowPersistentMarker({
    item,
    hasPersistentPolicy: policies.some(isPersistentReminderPolicy),
  })
    ? "❗ "
    : "";
  const calendarStatus =
    ["event", "training", "tentative_event"].includes(item.kind) &&
    ["pending_retry", "failed", "error"].includes(calendar?.status ?? "")
      ? ` · Календарь: ${calendar?.lastError ?? calendar?.status}, повторю автоматически`
      : "";
  return [
    `${time ? `${time}${end ? `–${end}` : ""} · ` : ""}${important ? `${important} ` : ""}${persistent}${item.title}${calendarStatus}`,
    ...policies.map(
      (policy) => `   🔔 ${formatHumanReminderPolicy(policy, timezone, { now, includeMarker: false })}`,
    ),
  ].join("\n");
}

function compareDashboardItems(left: PlannerItem, right: PlannerItem) {
  const leftRank = left.startAt ? 0 : left.dueAt ? 1 : 2;
  const rightRank = right.startAt ? 0 : right.dueAt ? 1 : 2;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return (
    (left.startAt ?? left.dueAt)?.getTime() ?? Number.MAX_SAFE_INTEGER
  ) - (
    (right.startAt ?? right.dueAt)?.getTime() ?? Number.MAX_SAFE_INTEGER
  );
}

function formatPolicy(policy: ReminderPolicy, timezone: string) {
  const priorityLabel = importanceMarker(getBasePriority({ policy })).split(" ")[0];
  return `${priorityLabel ? `${priorityLabel} · ` : ""}${policy.title}\n   ${formatHumanReminderPolicy(policy, timezone, { includeNext: true, includeMarker: false })}`;
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
