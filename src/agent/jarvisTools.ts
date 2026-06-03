import { DateTime } from "luxon";

import {
  cancelPlannerItem,
  listItemsBetween,
  listManageableItems,
  listOverdueOpenItems,
  markPlannerItemCompleted,
  restorePlannerItemStatus,
} from "@/db/queries/items";
import { cancelItemReminders } from "@/db/queries/reminders";
import { listItemsByIds, type TaskViewScope } from "@/db/queries/taskViewStates";
import type { PlannerItem } from "@/db/schema";

import { loadLatestUndoableAgentAction, rememberAgentAction } from "./state/actionHistory";
import { itemIdsForDisplayIndices, loadLatestTaskView, rememberTaskView } from "./state/taskViewState";
import { isLikelyGarbagePlannerItem, explainGarbageItem } from "./validation/antiGarbageValidator";
import { renderEveningReview } from "./views/renderEveningReview";
import { renderFullPlan } from "./views/renderFullPlan";
import { sortJarvisItemsForDisplay } from "./views/renderShared";
import { renderToday } from "./views/renderToday";
import { renderYesterdayReview } from "./views/renderYesterdayReview";
import type { JarvisToolResult } from "./types";

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
  const { items, title, viewScope } = await loadScheduleItems({
    userId: params.userId,
    timezone: params.timezone,
    now,
    scope: params.scope,
  });
  const displayItems = withDisplayIndices(items);
  const viewState = await rememberTaskView({
    userId: params.userId,
    scope: viewScope,
    title,
    items: displayItems,
    metadata: { jarvisTool: "render_schedule_view", scheduleScope: params.scope },
  });

  const reply =
    params.scope === "full"
      ? renderFullPlan({ items: displayItems, timezone: params.timezone })
      : renderToday({ title, items: displayItems, timezone: params.timezone });

  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "render_schedule_view",
    input: { scope: params.scope },
    output: { itemCount: displayItems.length, viewStateId: viewState?.id ?? null },
  });

  return {
    handled: true,
    reply,
    affectedItemIds: displayItems.map((item) => item.id),
    viewStateId: viewState?.id ?? null,
  };
}

export async function renderTaskViewTool(params: ToolParams): Promise<JarvisToolResult> {
  const items = withDisplayIndices(await listManageableItems(params.userId, 80));
  const viewState = await rememberTaskView({
    userId: params.userId,
    scope: "current",
    title: "Текущие задачи",
    items,
    metadata: { jarvisTool: "render_task_view" },
  });
  const reply = renderToday({
    title: "Текущие задачи",
    items,
    timezone: params.timezone,
  });
  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "render_task_view",
    output: { itemCount: items.length, viewStateId: viewState?.id ?? null },
  });
  return { handled: true, reply, affectedItemIds: items.map((item) => item.id), viewStateId: viewState?.id ?? null };
}

export async function renderYesterdayReviewTool(params: ToolParams): Promise<JarvisToolResult> {
  const now = params.now ?? new Date();
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(params.timezone);
  const from = nowLocal.minus({ days: 1 }).startOf("day").toUTC().toJSDate();
  const to = nowLocal.minus({ days: 1 }).endOf("day").toUTC().toJSDate();
  const items = withDisplayIndices(await listItemsBetween({ userId: params.userId, from, to, limit: 80 }));
  const viewState = await rememberTaskView({
    userId: params.userId,
    scope: "yesterday_review",
    title: "Разбор вчера",
    items,
    metadata: { jarvisTool: "render_yesterday_review" },
  });
  const reply = renderYesterdayReview({ items, timezone: params.timezone });
  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "render_yesterday_review",
    output: { itemCount: items.length, viewStateId: viewState?.id ?? null },
  });
  return { handled: true, reply, affectedItemIds: items.map((item) => item.id), viewStateId: viewState?.id ?? null };
}

export async function renderEveningReviewTool(params: ToolParams): Promise<JarvisToolResult> {
  const now = params.now ?? new Date();
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(params.timezone);
  const from = nowLocal.startOf("day").toUTC().toJSDate();
  const to = nowLocal.endOf("day").toUTC().toJSDate();
  const [todayItems, openItems] = await Promise.all([
    listItemsBetween({ userId: params.userId, from, to, limit: 80 }),
    listManageableItems(params.userId, 80),
  ]);
  const items = withDisplayIndices(dedupeItems([...todayItems, ...openItems]));
  const viewState = await rememberTaskView({
    userId: params.userId,
    scope: "evening_review",
    title: "Вечерняя проверка",
    items,
    metadata: { jarvisTool: "render_evening_review" },
  });
  const reply = renderEveningReview({ items, timezone: params.timezone });
  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "render_evening_review",
    output: { itemCount: items.length, viewStateId: viewState?.id ?? null },
  });
  return { handled: true, reply, affectedItemIds: items.map((item) => item.id), viewStateId: viewState?.id ?? null };
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
  const items = await listManageableItems(params.userId, 200);
  const garbage = items.filter(isLikelyGarbagePlannerItem);
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
    const updated = await cancelPlannerItem(params.userId, item.id);
    await cancelItemReminders(params.userId, item.id);
    if (updated) cancelled.push(updated);
  }

  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "cleanup_garbage",
    output: {
      cancelledItemIds: cancelled.map((item) => item.id),
      reasons: garbage.map((item) => ({ id: item.id, reason: explainGarbageItem(item) })),
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

  if (!action || !undoItems.length) {
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
  const dayOffset = params.scope === "tomorrow" ? 1 : 0;
  const from = todayStart.plus({ days: dayOffset }).toUTC().toJSDate();
  const to = todayStart
    .plus({ days: params.scope === "week" || params.scope === "full" ? 7 : dayOffset + 1 })
    .minus({ milliseconds: 1 })
    .toUTC()
    .toJSDate();

  const [scheduledItems, overdueItems, manageableItems] = await Promise.all([
    listItemsBetween({ userId: params.userId, from, to, limit: 120 }),
    params.scope === "today" || params.scope === "full" || params.scope === "week"
      ? listOverdueOpenItems({ userId: params.userId, before: from, limit: 50 })
      : Promise.resolve([]),
    params.scope === "tomorrow" ? Promise.resolve([]) : listManageableItems(params.userId, 120),
  ]);

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

  return {
    title,
    viewScope,
    items: dedupeItems([...overdueItems, ...scheduledItems, ...manageableItems]),
  };
}

function withDisplayIndices(items: PlannerItem[]): PlannerItem[] {
  return sortJarvisItemsForDisplay(items).map((item, index) => ({
    ...item,
    metadata: {
      ...(item.metadata ?? {}),
      displayIndex: index + 1,
    },
  }));
}

function dedupeItems(items: PlannerItem[]): PlannerItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
