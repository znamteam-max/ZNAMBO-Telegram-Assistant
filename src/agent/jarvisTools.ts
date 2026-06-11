import { DateTime } from "luxon";

import {
  cancelPlannerItem,
  cancelCalendarSyncJobsForItem,
  cancelPlannerItemWithMetadata,
  listAllActiveItems,
  listDailyDigestItems,
  listEveningReviewItems,
  listManageableItems,
  listRecentRangeItems,
  listVisibleActivePlanItems,
  listYesterdayCarryCandidates,
  markPlannerItemCompleted,
  restorePlannerItemStatus,
} from "@/db/queries/items";
import { cancelItemReminders, restoreReminderState } from "@/db/queries/reminders";
import { listItemsByIds, type TaskViewScope } from "@/db/queries/taskViewStates";
import { updateAgentAction } from "@/db/queries/agentActions";
import type { PlannerItem } from "@/db/schema";

import { loadLatestUndoableAgentAction, rememberAgentAction } from "./state/actionHistory";
import { itemIdsForDisplayIndices, loadLatestTaskView } from "./state/taskViewState";
import { sortJarvisItemsForDisplay } from "./views/renderShared";
import type { JarvisToolResult } from "./types";
import { renderAndSaveTaskView, type TaskViewSection } from "./views/renderAndSaveTaskView";
import { prepareActivePlanReset } from "@/services/activePlanReset";
import { resetActivePlanKeyboard } from "@/bot/keyboards";
import { isGarbageOrTestItem } from "@/domain/itemVisibility";
import { undoLastReminderPolicyEdit } from "@/services/reminderPolicyEditor";

type ToolParams = {
  userId: string;
  timezone: string;
  now?: Date;
  sourceMessageId?: string | null;
};

export async function renderScheduleViewTool(params: ToolParams & {
  scope: "full" | "today" | "tomorrow" | "week";
}): Promise<JarvisToolResult> {
  const now = params.now ?? new Date();
  const { sections, title, viewScope } = await loadScheduleItems({
    userId: params.userId,
    timezone: params.timezone,
    now,
    scope: params.scope,
  });
  const rendered = await renderAndSaveTaskView({
    userId: params.userId,
    timezone: params.timezone,
    viewType: viewScope,
    title,
    sections,
    intro:
      params.scope === "full"
        ? "Ничего нового не создаю. Показываю текущий активный план."
        : undefined,
    emptyText:
      params.scope === "today"
        ? "Сегодня пока пусто. Можешь надиктовать дела, а я соберу план."
        : "Пока пусто.",
    footer: "Номера в списке можно использовать в следующих сообщениях.",
    metadata: { jarvisTool: "render_schedule_view", scheduleScope: params.scope },
  });

  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "render_schedule_view",
    input: { scope: params.scope },
    output: { itemCount: rendered.items.length, viewStateId: rendered.viewState?.id ?? null },
  });

  return {
    handled: true,
    reply: rendered.reply,
    affectedItemIds: rendered.items.map((item) => item.id),
    viewStateId: rendered.viewState?.id ?? null,
    replyMarkup: rendered.replyMarkup,
  };
}

export async function renderTaskViewTool(params: ToolParams): Promise<JarvisToolResult> {
  const items = await listManageableItems(params.userId, 80);
  const rendered = await renderAndSaveTaskView({
    userId: params.userId,
    timezone: params.timezone,
    viewType: "current",
    title: "Текущие задачи",
    sections: buildDisplaySections(items, params.now ?? new Date()),
    intro: "Ничего нового не создаю. Показываю задачи для управления.",
    emptyText: "Сейчас открытых задач нет.",
    footer: "Можно написать: удалить 1 и 3, отметить 2 выполненным.",
    metadata: { jarvisTool: "render_task_view" },
  });
  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "render_task_view",
    output: { itemCount: rendered.items.length, viewStateId: rendered.viewState?.id ?? null },
  });
  return {
    handled: true,
    reply: rendered.reply,
    affectedItemIds: rendered.items.map((item) => item.id),
    viewStateId: rendered.viewState?.id ?? null,
    replyMarkup: rendered.replyMarkup,
  };
}

export async function renderYesterdayReviewTool(params: ToolParams): Promise<JarvisToolResult> {
  const now = params.now ?? new Date();
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(params.timezone);
  const from = nowLocal.minus({ days: 1 }).startOf("day").toUTC().toJSDate();
  const to = nowLocal.minus({ days: 1 }).endOf("day").toUTC().toJSDate();
  const items = await listRecentRangeItems({ userId: params.userId, from, to, limit: 80 });
  const rendered = await renderAndSaveTaskView({
    userId: params.userId,
    timezone: params.timezone,
    viewType: "yesterday_review",
    title: "Разбор вчера",
    sections: buildStatusSections(items),
    intro: "Ничего нового не создаю. Можно ответить номерами, что выполнено или что удалить.",
    emptyText: "За вчера нет записей для разбора.",
    footer: "Например: выполнено 1 и 3. Или: удалить 2.",
    metadata: { jarvisTool: "render_yesterday_review" },
  });
  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "render_yesterday_review",
    output: { itemCount: rendered.items.length, viewStateId: rendered.viewState?.id ?? null },
  });
  return {
    handled: true,
    reply: rendered.reply,
    affectedItemIds: rendered.items.map((item) => item.id),
    viewStateId: rendered.viewState?.id ?? null,
    replyMarkup: rendered.replyMarkup,
  };
}

export async function renderEveningReviewTool(params: ToolParams): Promise<JarvisToolResult> {
  const now = params.now ?? new Date();
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(params.timezone);
  const from = nowLocal.startOf("day").toUTC().toJSDate();
  const to = nowLocal.endOf("day").toUTC().toJSDate();
  const items = await listEveningReviewItems({ userId: params.userId, from, to, limit: 80 });
  const rendered = await renderAndSaveTaskView({
    userId: params.userId,
    timezone: params.timezone,
    viewType: "evening_review",
    title: "Вечерняя проверка",
    sections: [{ title: "Сегодня", items: sortJarvisItemsForDisplay(items) }],
    intro: "Показываю только незакрытые записи текущего дня.",
    emptyText: "На сегодня незакрытых задач нет.",
    footer: "Можно написать: 1 выполнено, 2 на завтра, всё закрыть.",
    metadata: { jarvisTool: "render_evening_review" },
  });
  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "render_evening_review",
    output: { itemCount: rendered.items.length, viewStateId: rendered.viewState?.id ?? null },
  });
  return {
    handled: true,
    reply: rendered.reply,
    affectedItemIds: rendered.items.map((item) => item.id),
    viewStateId: rendered.viewState?.id ?? null,
    replyMarkup: rendered.replyMarkup,
  };
}

export async function renderRecentRangeTool(params: ToolParams & {
  days: number;
}): Promise<JarvisToolResult> {
  const now = params.now ?? new Date();
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(params.timezone);
  const days = Math.max(1, Math.min(14, params.days));
  const from = nowLocal.minus({ days: days - 1 }).startOf("day").toUTC().toJSDate();
  const to = nowLocal.endOf("day").toUTC().toJSDate();
  const items = await listRecentRangeItems({ userId: params.userId, from, to, limit: 160 });
  const sections: TaskViewSection[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = nowLocal.minus({ days: offset });
    const dayFrom = day.startOf("day").toUTC().toJSDate();
    const dayTo = day.endOf("day").toUTC().toJSDate();
    const dayItems = items.filter((item) => {
      const when = item.startAt ?? item.dueAt;
      return Boolean(when && when >= dayFrom && when <= dayTo);
    });
    sections.push({
      title: offset === 0 ? "Сегодня" : offset === 1 ? "Вчера" : day.toFormat("dd.LL"),
      items: sortJarvisItemsForDisplay(dayItems),
    });
  }

  const rendered = await renderAndSaveTaskView({
    userId: params.userId,
    timezone: params.timezone,
    viewType: "recent_range",
    title: `План за последние ${days} дня`,
    sections,
    intro: "Показываю записи по датам. Ничего нового не создаю.",
    emptyText: "За этот период записей нет.",
    footer: "Номера можно использовать для удаления или отметки выполнения.",
    metadata: { jarvisTool: "render_recent_range", days },
  });
  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "render_recent_range",
    input: { days },
    output: { itemCount: rendered.items.length, viewStateId: rendered.viewState?.id ?? null },
  });
  return {
    handled: true,
    reply: rendered.reply,
    affectedItemIds: rendered.items.map((item) => item.id),
    viewStateId: rendered.viewState?.id ?? null,
    replyMarkup: rendered.replyMarkup,
  };
}

export async function prepareResetActivePlanTool(params: ToolParams): Promise<JarvisToolResult> {
  const { action, preview } = await prepareActivePlanReset({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    mode: "all",
  });
  return {
    handled: true,
    reply: [
      "Понял. Ничего нового не создаю.",
      "",
      "Могу очистить активный план:",
      "• все незавершённые задачи;",
      "• просроченные пункты;",
      "• предварительные события;",
      "• тестовые и ошибочные записи;",
      "• будущие напоминания, привязанные к ним.",
      "",
      "Сохранятся:",
      "• история переписки;",
      "• завершённые дела;",
      "• память и пользовательские правила;",
      "• recurring-настройки.",
      "",
      `Открытых задач: ${preview.openItemCount}`,
      `Будет очищено: ${preview.resettableItemCount}`,
      `Ошибочных записей: ${preview.garbageItemCount}`,
      `Тестовых записей: ${preview.testItemCount}`,
      `Активных напоминаний: ${preview.activeReminderCount}`,
      "",
      "Очистить активный план?",
    ].join("\n"),
    affectedItemIds: [],
    metadata: { actionId: action.id, preview },
    replyMarkup: resetActivePlanKeyboard(action.id),
  };
}

export async function deleteItemsByIndicesTool(params: ToolParams & {
  text: string;
}): Promise<JarvisToolResult> {
  const indices = parseDisplayIndexSelection(params.text);
  const { items, missingIndices } = await resolveItemsFromLatestView(params.userId, indices);
  if (!indices.length || !items.length) {
    await rememberAgentAction({
      userId: params.userId,
      sourceMessageId: params.sourceMessageId,
      actionType: "delete_by_indices",
      status: "noop",
      input: { text: params.text, indices },
      output: { missingIndices },
    });
    return {
      handled: true,
      reply: "Не нашел номера из последнего списка. Сначала попроси /tasks или «дай план целиком», потом можно удалять по номерам.",
      affectedItemIds: [],
      status: "noop",
    };
  }

  const cancelled: PlannerItem[] = [];
  for (const item of items) {
    const updated = await cancelPlannerItem(params.userId, item.id);
    await cancelItemReminders(params.userId, item.id);
    await cancelCalendarSyncJobsForItem(item.id);
    if (updated) cancelled.push(updated);
  }

  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "delete_by_indices",
    input: { text: params.text, indices },
    output: { cancelledItemIds: cancelled.map((item) => item.id), missingIndices },
    undoPayload: {
      items: items.map((item) => ({
        id: item.id,
        status: item.status,
        completedAt: item.completedAt?.toISOString() ?? null,
      })),
    },
  });

  return {
    handled: true,
    reply: [
      `Удалил ${cancelled.length}:`,
      ...cancelled.map((item) => `- ${item.title}`),
      missingIndices.length ? `Не нашел номера: ${missingIndices.join(", ")}.` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    affectedItemIds: cancelled.map((item) => item.id),
  };
}

export async function markDoneByIndicesTool(params: ToolParams & {
  text: string;
}): Promise<JarvisToolResult> {
  const indices = parseDisplayIndexSelection(params.text);
  const { items, missingIndices } = await resolveItemsFromLatestView(params.userId, indices);
  if (!indices.length || !items.length) {
    await rememberAgentAction({
      userId: params.userId,
      sourceMessageId: params.sourceMessageId,
      actionType: "mark_done_by_indices",
      status: "noop",
      input: { text: params.text, indices },
      output: { missingIndices },
    });
    return {
      handled: true,
      reply: "Не нашел эти номера в последнем списке. Сначала покажи список через /tasks или «дай план целиком».",
      affectedItemIds: [],
      status: "noop",
    };
  }

  const completed: PlannerItem[] = [];
  for (const item of items) {
    const updated = await markPlannerItemCompleted(params.userId, item.id);
    await cancelItemReminders(params.userId, item.id);
    if (updated) completed.push(updated);
  }

  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "mark_done_by_indices",
    input: { text: params.text, indices },
    output: { completedItemIds: completed.map((item) => item.id), missingIndices },
    undoPayload: {
      items: items.map((item) => ({
        id: item.id,
        status: item.status,
        completedAt: item.completedAt?.toISOString() ?? null,
      })),
    },
  });

  return {
    handled: true,
    reply: [
      `Отметил выполненным ${completed.length}:`,
      ...completed.map((item) => `- ${item.title}`),
      missingIndices.length ? `Не нашел номера: ${missingIndices.join(", ")}.` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    affectedItemIds: completed.map((item) => item.id),
  };
}

export async function cleanupGarbageTool(params: ToolParams): Promise<JarvisToolResult> {
  const items = await listAllActiveItems(params.userId, 500);
  const garbage = items.filter(isGarbageOrTestItem);
  if (!garbage.length) {
    await rememberAgentAction({
      userId: params.userId,
      sourceMessageId: params.sourceMessageId,
      actionType: "cleanup_garbage",
      status: "noop",
      output: { cancelledItemIds: [] },
    });
    return {
      handled: true,
      reply: "Проверил текущие задачи: явного мусора не нашел.",
      affectedItemIds: [],
      status: "noop",
    };
  }

  const cancelled: PlannerItem[] = [];
  for (const item of garbage) {
    const updated = await cancelPlannerItemWithMetadata({
      userId: params.userId,
      itemId: item.id,
      metadata: {
        garbage: true,
        garbageReason:
          item.metadata?.garbageReason ?? "production_garbage_cleanup",
        archivedAt: new Date().toISOString(),
      },
    });
    await cancelItemReminders(params.userId, item.id);
    await cancelCalendarSyncJobsForItem(item.id);
    if (updated) cancelled.push(updated);
  }

  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "cleanup_garbage",
    output: {
      cancelledItemIds: cancelled.map((item) => item.id),
      reasons: garbage.map((item) => ({
        id: item.id,
        reason: String(item.metadata?.garbageReason ?? "production_garbage_cleanup"),
      })),
    },
    undoPayload: {
      items: garbage.map((item) => ({
        id: item.id,
        status: item.status,
        completedAt: item.completedAt?.toISOString() ?? null,
      })),
    },
  });

  return {
    handled: true,
    reply: ["Почистил мусор:", ...cancelled.map((item) => `- ${item.title}`)].join("\n"),
    affectedItemIds: cancelled.map((item) => item.id),
  };
}

export async function undoLastActionTool(params: ToolParams): Promise<JarvisToolResult> {
  const action = await loadLatestUndoableAgentAction(params.userId);
  const undoItems = (action?.undoPayload?.items ?? []) as Array<{
    id?: string;
    status?: string;
    completedAt?: string | null;
  }>;
  const undoReminders = (action?.undoPayload?.reminders ?? []) as Array<{
    id?: string;
    status?: string;
    scheduledAt?: string;
  }>;

  if (!action || !undoItems.length) {
    const restoredPolicy = await undoLastReminderPolicyEdit(params.userId);
    if (restoredPolicy) {
      return {
        handled: true,
        reply: `Откатил последнее изменение напоминания: ${restoredPolicy.title}.`,
        affectedItemIds: restoredPolicy.itemId ? [restoredPolicy.itemId] : [],
      };
    }
    return {
      handled: true,
      reply: "Пока нет последнего удаления или cleanup, который можно откатить.",
      affectedItemIds: [],
      status: "noop",
    };
  }

  const restored: PlannerItem[] = [];
  for (const item of undoItems) {
    if (!item.id || !item.status) continue;
    const restoredItem = await restorePlannerItemStatus({
      userId: params.userId,
      itemId: item.id,
      status: item.status,
      completedAt: item.completedAt ? new Date(item.completedAt) : null,
    });
    if (restoredItem) restored.push(restoredItem);
  }
  for (const reminder of undoReminders) {
    if (!reminder.id || !reminder.status || !reminder.scheduledAt) continue;
    const scheduledAt = new Date(reminder.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) continue;
    await restoreReminderState({
      userId: params.userId,
      reminderId: reminder.id,
      status: reminder.status,
      scheduledAt,
    });
  }
  await updateAgentAction({
    userId: params.userId,
    actionId: action.id,
    status: "undone",
    output: {
      restoredItemIds: restored.map((item) => item.id),
      restoredFutureReminderCount: undoReminders.length,
    },
  });

  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "undo_last_action",
    input: { actionId: action.id, actionType: action.actionType },
    output: { restoredItemIds: restored.map((item) => item.id) },
  });

  return {
    handled: true,
    reply: [
      `Откатил последнее действие: ${action.actionType}.`,
      ...restored.map((item) => `- ${item.title}`),
      "Напоминания, которые уже были отменены при удалении, нужно будет поставить заново, если они еще нужны.",
    ].join("\n"),
    affectedItemIds: restored.map((item) => item.id),
  };
}

export function parseDisplayIndexSelection(text: string): number[] {
  const indices: number[] = [];
  for (const match of text.matchAll(/\b(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?\b/g)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    for (let index = from; index <= to && index <= from + 100; index += 1) {
      if (index > 0) indices.push(index);
    }
  }
  return [...new Set(indices)].sort((a, b) => a - b);
}

async function resolveItemsFromLatestView(userId: string, indices: number[]) {
  const viewState = await loadLatestTaskView(userId);
  const itemIds = itemIdsForDisplayIndices(viewState, indices);
  const foundIndexSet = new Set(
    (viewState?.itemsSnapshot as Array<{ displayIndex?: number }> | undefined)
      ?.filter((item) => typeof item.displayIndex === "number" && indices.includes(item.displayIndex))
      .map((item) => item.displayIndex as number) ?? [],
  );
  const missingIndices = indices.filter((index) => !foundIndexSet.has(index));
  const items = await listItemsByIds(userId, itemIds);
  return { items, missingIndices, viewState };
}

async function loadScheduleItems(params: {
  userId: string;
  timezone: string;
  now: Date;
  scope: "full" | "today" | "tomorrow" | "week";
}) {
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const todayStart = nowLocal.startOf("day");
  const title =
    params.scope === "full"
      ? "План целиком"
      : params.scope === "tomorrow"
        ? "Завтра"
        : params.scope === "week"
          ? "Ближайшие 7 дней"
          : "Сегодня";
  const viewScope: TaskViewScope =
    params.scope === "full" ? "current" : params.scope === "week" ? "week" : params.scope;

  if (params.scope === "full") {
    const items = await listVisibleActivePlanItems(params.userId, 200);
    return { title, viewScope, sections: buildDisplaySections(items, params.now) };
  }

  const dayOffset = params.scope === "tomorrow" ? 1 : 0;
  const from = todayStart.plus({ days: dayOffset }).toUTC().toJSDate();
  const to = todayStart
    .plus({ days: params.scope === "week" ? 7 : dayOffset + 1 })
    .minus({ milliseconds: 1 })
    .toUTC()
    .toJSDate();
  const items = await listDailyDigestItems({ userId: params.userId, from, to, limit: 120 });
  const sections: TaskViewSection[] = [{ title: title, items: sortJarvisItemsForDisplay(items) }];
  if (params.scope === "today") {
    const yesterdayFrom = todayStart.minus({ days: 1 }).toUTC().toJSDate();
    const yesterdayTo = todayStart.minus({ milliseconds: 1 }).toUTC().toJSDate();
    const carry = await listYesterdayCarryCandidates({
      userId: params.userId,
      from: yesterdayFrom,
      to: yesterdayTo,
      limit: 10,
    });
    if (carry.length) sections.push({ title: "Со вчера осталось", items: sortJarvisItemsForDisplay(carry) });
  }
  return { title, viewScope, sections };
}

function buildDisplaySections(items: PlannerItem[], now: Date): TaskViewSection[] {
  const overdue: PlannerItem[] = [];
  const scheduled: PlannerItem[] = [];
  const training: PlannerItem[] = [];
  const recurring: PlannerItem[] = [];
  const floating: PlannerItem[] = [];
  const notes: PlannerItem[] = [];
  for (const item of sortJarvisItemsForDisplay(items)) {
    const when = item.startAt ?? item.dueAt;
    if (item.kind === "recurring_task") recurring.push(item);
    else if (item.kind === "training") training.push(item);
    else if (item.kind === "note") notes.push(item);
    else if (when && when < now) overdue.push(item);
    else if (!when || item.metadata?.isFloating === true || item.metadata?.timeUnspecified === true) floating.push(item);
    else scheduled.push(item);
  }
  return [
    { title: "Просрочено", items: overdue },
    { title: "Расписание", items: scheduled },
    { title: "Тренировки", items: training },
    { title: "Повторяющиеся", items: recurring },
    { title: "Без времени", items: floating },
    { title: "Заметки", items: notes },
  ];
}

function buildStatusSections(items: PlannerItem[]): TaskViewSection[] {
  return [
    { title: "Открыто", items: sortJarvisItemsForDisplay(items.filter((item) => item.status === "active")) },
    { title: "Выполнено", items: sortJarvisItemsForDisplay(items.filter((item) => item.status === "completed")) },
    { title: "Отменено", items: sortJarvisItemsForDisplay(items.filter((item) => item.status === "cancelled")) },
  ];
}
