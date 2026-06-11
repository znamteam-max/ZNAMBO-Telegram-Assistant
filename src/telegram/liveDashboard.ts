import { DateTime } from "luxon";

import {
  createActiveDashboard,
  getActiveDashboard,
  markDashboardStatus,
} from "@/db/queries/liveDashboards";
import { listLegacyReminderLikeItems, listRecentRangeItems } from "@/db/queries/items";
import {
  listActiveReminderPolicies,
  listActiveReminderPoliciesByCategory,
  listLongTermReminderPolicies,
} from "@/db/queries/reminderPolicies";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { logger } from "@/lib/logger";
import {
  classifyTimelineItem,
  compareTimelineEntries,
  getEffectivePriority,
} from "@/domain/timelineClassification";

import { getBot } from "@/bot/createBot";
import { liveDashboardKeyboard } from "@/bot/keyboards";
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
  const from = local.startOf("day").toUTC().toJSDate();
  const to = local.endOf("day").toUTC().toJSDate();
  const [items, policies] = await Promise.all([
    listRecentRangeItems({ userId: params.userId, from, to, limit: 80 }),
    listActiveReminderPolicies(params.userId, 80),
  ]);
  const todayItems = items
    .filter((item) => item.status === "active" || item.status === "completed")
    .sort((a, b) =>
      compareTimelineEntries({ item: a }, { item: b }, now, params.timezone),
    )
    .slice(0, 7);
  const displayPolicies = groupCampaignPolicies(policies);
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
  const distant = displayPolicies
    .filter((policy) => {
      if (naggingIds.has(policy.id) || soonIds.has(policy.id)) return false;
      return ["distant", "long_term"].includes(
        classifyTimelineItem({ policy }, now, params.timezone),
      );
    })
    .sort((a, b) =>
      compareTimelineEntries({ policy: a }, { policy: b }, now, params.timezone),
    )
    .slice(0, 4);

  const lines = [`JARVIS · Сегодня, ${local.toFormat("d LLLL")}`];
  lines.push("", "Сейчас / ближайшее:");
  if (todayItems.length) {
    lines.push(
      ...todayItems.map((item, index) => formatDashboardItem(item, index + 1, params.timezone)),
    );
  } else {
    lines.push("План на сегодня пока пуст.");
  }
  if (nagging.length) {
    lines.push("", "Активные напоминания:");
    lines.push(...nagging.map((policy) => `• ${formatPolicy(policy, params.timezone)}`));
  }
  if (soon.length) {
    lines.push("", "Скоро:");
    lines.push(...soon.map((policy) => `• ${formatPolicy(policy, params.timezone)}`));
  }
  if (distant.length) {
    lines.push("", "Дальние по приоритету:");
    lines.push(...distant.map((policy) => `• ${formatPolicy(policy, params.timezone)}`));
  }

  return {
    text: lines.join("\n"),
    items: todayItems,
    policies: displayPolicies,
    keyboard: liveDashboardKeyboard(todayItems),
  };
}

export async function renderReminderPolicyList(params: {
  userId: string;
  timezone: string;
  longTermOnly?: boolean;
  category?: string | null;
}) {
  const [policies, legacyAll] = await Promise.all([
    params.category
      ? listActiveReminderPoliciesByCategory(params.userId, params.category, 100)
      : params.longTermOnly
        ? listLongTermReminderPolicies(params.userId, 100)
        : listActiveReminderPolicies(params.userId, 100),
    listLegacyReminderLikeItems(params.userId, 50),
  ]);
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

function formatDashboardItem(item: PlannerItem, index: number, timezone: string) {
  if (item.status === "completed") return `${index}. ✅ ${item.title} — завершено`;
  const start = item.startAt ?? item.dueAt;
  const time = start
    ? DateTime.fromJSDate(start, { zone: "utc" })
        .setZone(item.timezone || timezone)
        .toFormat("HH:mm")
    : "без времени";
  const end = item.endAt
    ? DateTime.fromJSDate(item.endAt, { zone: "utc" })
        .setZone(item.timezone || timezone)
        .toFormat("HH:mm")
    : null;
  const marker = item.kind === "training" ? "🟢" : item.kind === "preparation_task" ? "🟡" : "🔴";
  return `${index}. ${marker} ${time}${end ? `–${end}` : ""} · ${item.title}`;
}

function formatPolicy(policy: ReminderPolicy, timezone: string) {
  const next = policy.nextFireAt
    ? DateTime.fromJSDate(policy.nextFireAt, { zone: "utc" })
        .setZone(policy.timezone || timezone)
        .toFormat("dd.LL HH:mm")
    : "без ближайшего запуска";
  const priority = getEffectivePriority({ policy }, new Date(), timezone);
  const priorityLabel = priority !== 3 ? `P${priority} · ` : "";
  if (policy.policyType === "interval_window") {
    return `${priorityLabel}${policy.title}: каждые ${policy.intervalMinutes ?? "?"} мин, следующее ${next}`;
  }
  return `${priorityLabel}${policy.title} — ${next}`;
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
