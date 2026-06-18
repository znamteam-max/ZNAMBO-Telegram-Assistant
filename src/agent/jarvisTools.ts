import { DateTime } from "luxon";

import {
  cancelPlannerItem,
  cancelCalendarSyncJobsForItem,
  listAllActiveItems,
  listDailyDigestItems,
  listEveningReviewItems,
  listRecentRangeItems,
  listVisibleActivePlanItems,
  listYesterdayCarryCandidates,
  markPlannerItemCompleted,
  restorePlannerItemSnapshot,
  restorePlannerItemStatus,
  updatePlannerItemSchedule,
} from "@/db/queries/items";
import {
  cancelItemReminders,
  cancelPendingRemindersForPolicy,
  restoreReminderState,
} from "@/db/queries/reminders";
import { updateReminderPolicy } from "@/db/queries/reminderPolicies";
import { listItemsByIds, type TaskViewScope } from "@/db/queries/taskViewStates";
import { getAgentActionById, updateAgentAction } from "@/db/queries/agentActions";
import type { PlannerItem, TaskViewState } from "@/db/schema";

import { loadLatestUndoableAgentAction, rememberAgentAction } from "./state/actionHistory";
import { itemIdsForDisplayIndices, loadLatestTaskView } from "./state/taskViewState";
import { sortJarvisItemsForDisplay } from "./views/renderShared";
import type { JarvisToolResult } from "./types";
import { renderAndSaveTaskView, type TaskViewSection } from "./views/renderAndSaveTaskView";
import { prepareActivePlanReset } from "@/services/activePlanReset";
import {
  entityListKeyboard,
  resetActivePlanKeyboard,
  safeMutationPreviewKeyboard,
  undoActionKeyboard,
} from "@/bot/keyboards";
import { isGarbageOrTestItem } from "@/domain/itemVisibility";
import { isPinnedContextNote } from "@/domain/pinnedContextNotes";
import { undoLastReminderPolicyEdit } from "@/services/reminderPolicyEditor";
import { buildUserTimelineView } from "@/services/userTimeline";

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
  const timeline = await buildUserTimelineView({
    userId: params.userId,
    timezone: params.timezone,
    now: params.now,
  });
  const items = timeline.rows
    .filter(
      (row) =>
        row.item &&
        !isPinnedContextNote(row.item) &&
        !["history", "hidden"].includes(row.dateBucket),
    )
    .map((row) => row.item!);
  const unresolvedCount = timeline.byBucket.unresolvedPast.filter((row) => row.item).length;
  const rendered = await renderAndSaveTaskView({
    userId: params.userId,
    timezone: params.timezone,
    viewType: "current",
    title: "Текущие задачи",
    sections: buildDisplaySections(items, params.now ?? new Date()),
    intro: [
      "Ничего нового не создаю. Показываю задачи для управления.",
      unresolvedCount
        ? `Неразобранное прошлое: ${unresolvedCount} пунктов требуют решения. Открой /history или /review.`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
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
  const indices = parseDeleteIndexSelection(params.text);
  const viewState = await loadLatestTaskView(params.userId);
  const { items, missingIndices } = await resolveItemsFromView(
    params.userId,
    viewState,
    indices,
  );
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

  const scheduleChange = parseScheduleChange(params.text);
  const scheduleTarget = scheduleChange
    ? (await resolveItemsFromView(params.userId, viewState, [scheduleChange.index])).items[0] ?? null
    : null;
  const action = await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "numbered_mutation_preview",
    status: "pending",
    input: { text: params.text, indices },
    output: {
      viewStateId: viewState?.id ?? null,
      deleteItems: items.map((item) => ({ id: item.id, title: item.title })),
      scheduleChange:
        scheduleChange && scheduleTarget
          ? {
              itemId: scheduleTarget.id,
              title: scheduleTarget.title,
              startTime: scheduleChange.startTime,
              endTime: scheduleChange.endTime,
            }
          : null,
      missingIndices,
    },
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
      "Ты хочешь:",
      "",
      "Удалить:",
      ...items.map((item) => `${indices[items.indexOf(item)] ?? "•"}. ${item.title}`),
      scheduleChange && scheduleTarget ? "" : null,
      scheduleChange && scheduleTarget ? "Изменить:" : null,
      scheduleChange && scheduleTarget
        ? `${scheduleChange.index}. ${scheduleTarget.title} → ${scheduleChange.startTime}–${scheduleChange.endTime}`
        : null,
      missingIndices.length ? `Не нашел номера: ${missingIndices.join(", ")}.` : null,
      "",
      "Подтвердить?",
    ]
      .filter(Boolean)
      .join("\n"),
    affectedItemIds: [],
    status: "noop",
    replyMarkup: action ? safeMutationPreviewKeyboard(action.id) : undefined,
    metadata: { previewOnly: true, viewStateId: viewState?.id ?? null },
  };
}

export async function confirmNumberedMutationTool(params: ToolParams & {
  actionId: string;
}): Promise<JarvisToolResult> {
  const action = await getAgentActionById({ userId: params.userId, actionId: params.actionId });
  if (!action || action.actionType !== "numbered_mutation_preview" || action.status !== "pending") {
    return {
      handled: true,
      reply: "Это подтверждение уже обработано или устарело.",
      affectedItemIds: [],
      status: "noop",
    };
  }
  const output = action.output as {
    deleteItems?: Array<{ id?: string; title?: string }>;
    scheduleChange?: {
      itemId?: string;
      title?: string;
      startTime?: string;
      endTime?: string;
    } | null;
  };
  const deleted: PlannerItem[] = [];
  for (const entry of output.deleteItems ?? []) {
    if (!entry.id) continue;
    const item = await cancelPlannerItem(params.userId, entry.id);
    if (!item) continue;
    await cancelItemReminders(params.userId, item.id);
    await cancelCalendarSyncJobsForItem(item.id);
    deleted.push(item);
  }

  let updated: PlannerItem | null = null;
  if (
    output.scheduleChange?.itemId &&
    output.scheduleChange.startTime &&
    output.scheduleChange.endTime
  ) {
    const item = await listItemsByIds(params.userId, [output.scheduleChange.itemId]).then(
      (rows) => rows[0] ?? null,
    );
    if (item) {
      const anchor = item.startAt ?? item.dueAt ?? params.now ?? new Date();
      const localDate = DateTime.fromJSDate(anchor, { zone: "utc" }).setZone(
        item.timezone || params.timezone,
      );
      const startAt = applyClock(localDate, output.scheduleChange.startTime);
      const endAt = applyClock(localDate, output.scheduleChange.endTime);
      updated = await updatePlannerItemSchedule({
        userId: params.userId,
        itemId: item.id,
        startAt: startAt.toUTC().toJSDate(),
        endAt: endAt.toUTC().toJSDate(),
        dueAt: item.kind === "event" ? null : startAt.toUTC().toJSDate(),
        metadata: { mutationSource: "confirmed_numbered_mutation" },
      });
    }
  }

  await updateAgentAction({
    userId: params.userId,
    actionId: action.id,
    status: "completed",
    output: {
      ...output,
      cancelledItemIds: deleted.map((item) => item.id),
      updatedItemIds: updated ? [updated.id] : [],
    },
    undoPayload: action.undoPayload,
  });
  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "delete_by_indices",
    output: { cancelledItemIds: deleted.map((item) => item.id), previewActionId: action.id },
    undoPayload: action.undoPayload,
  });

  return {
    handled: true,
    reply: [
      deleted.length ? `Удалил ${deleted.length} пунктов.` : null,
      updated ? `Изменил время: ${updated.title}.` : null,
    ]
      .filter(Boolean)
      .join("\n") || "Изменений не потребовалось.",
    affectedItemIds: [...deleted.map((item) => item.id), ...(updated ? [updated.id] : [])],
    replyMarkup: deleted.length ? undoActionKeyboard() : undefined,
  };
}

export async function cancelNumberedMutationTool(params: ToolParams & {
  actionId: string;
}): Promise<JarvisToolResult> {
  const action = await getAgentActionById({ userId: params.userId, actionId: params.actionId });
  if (action?.status === "pending") {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: action.output,
      undoPayload: action.undoPayload,
    });
  }
  return {
    handled: true,
    reply: "Отменил. Ничего не изменено.",
    affectedItemIds: [],
    status: "noop",
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
  const now = params.now ?? new Date();
  const duplicates = duplicateItemIds(items);
  const garbage = items.filter((item) => {
    if (isPinnedContextNote(item)) return false;
    const anchor = item.startAt ?? item.dueAt;
    return (
      isGarbageOrTestItem(item) ||
      duplicates.has(item.id) ||
      Boolean(
        anchor &&
          anchor.getTime() < now.getTime() - 48 * 60 * 60 * 1000 &&
          item.kind !== "event" &&
          item.kind !== "recurring_task" &&
          item.visibility !== "history",
      )
    );
  });
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

  await rememberAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: "cleanup_garbage",
    status: "noop",
    output: { candidateItemIds: garbage.map((item) => item.id) },
  });

  return {
    handled: true,
    reply: [
      "Нашёл возможный мусор или старые неразобранные записи. Ничего не удаляю без выбора:",
      ...garbage.map((item, index) => `${index + 1}. ${item.title} — ${garbageReason(item, duplicates, now)}`),
      "",
      "Открой карточку номером и выбери удалить/изменить, либо запусти /admin_repair_v252 apply для безопасного production repair.",
    ].join("\n"),
    affectedItemIds: garbage.map((item) => item.id),
    replyMarkup: entityListKeyboard(
      garbage.map((item) => ({ type: "planner_item", id: item.id })),
    ),
  };
}

export async function undoLastActionTool(params: ToolParams): Promise<JarvisToolResult> {
  const action = await loadLatestUndoableAgentAction(params.userId);
  const undoItems = (action?.undoPayload?.items ?? []) as Array<{
    id?: string;
    kind?: string;
    status?: string;
    title?: string;
    description?: string | null;
    location?: string | null;
    timezone?: string;
    startAt?: string | null;
    endAt?: string | null;
    dueAt?: string | null;
    completedAt?: string | null;
    cancelledAt?: string | null;
    archivedAt?: string | null;
    category?: string | null;
    visibility?: string | null;
    priority?: number;
    metadata?: Record<string, unknown>;
  }>;
  const undoReminders = (action?.undoPayload?.reminders ?? []) as Array<{
    id?: string;
    status?: string;
    scheduledAt?: string;
  }>;
  const undoPolicies = (action?.undoPayload?.reminderPolicies ?? []) as Array<{
    id?: string;
    title?: string;
    category?: string;
    policyType?: string;
    status?: string;
    startsAt?: string | null;
    endsAt?: string | null;
    nextFireAt?: string | null;
    recurrenceRule?: string | null;
    intervalMinutes?: number | null;
    requireAck?: boolean;
    catchUpMode?: string;
    onWindowEnd?: string;
    metadata?: Record<string, unknown>;
  }>;
  const createdPolicyIds = (action?.undoPayload?.createdPolicyIds ?? []) as string[];

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
  for (const rawItem of undoItems) {
    const item = normalizeUndoItemSnapshot(rawItem);
    if (!item.id || !item.status) continue;
    const restoredItem =
      item.title && item.kind && item.timezone
        ? await restorePlannerItemSnapshot({
            userId: params.userId,
            itemId: item.id,
            kind: item.kind,
            status: item.status,
            title: item.title,
            description: item.description,
            location: item.location,
            timezone: item.timezone,
            startAt: parseUndoDate(item.startAt),
            endAt: parseUndoDate(item.endAt),
            dueAt: parseUndoDate(item.dueAt),
            completedAt: parseUndoDate(item.completedAt),
            cancelledAt: parseUndoDate(item.cancelledAt),
            archivedAt: parseUndoDate(item.archivedAt),
            category: item.category,
            visibility: item.visibility,
            priority: item.priority,
            metadata: item.metadata,
          })
        : await restorePlannerItemStatus({
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
  for (const policy of undoPolicies) {
    if (!policy.id) continue;
    await updateReminderPolicy({
      userId: params.userId,
      policyId: policy.id,
      status: policy.status,
      title: policy.title,
      category: policy.category,
      policyType: policy.policyType,
      startsAt: parseUndoDate(policy.startsAt),
      endsAt: parseUndoDate(policy.endsAt),
      nextFireAt: parseUndoDate(policy.nextFireAt),
      recurrenceRule: policy.recurrenceRule,
      intervalMinutes: policy.intervalMinutes,
      requireAck: policy.requireAck,
      catchUpMode: policy.catchUpMode,
      onWindowEnd: policy.onWindowEnd,
      metadata: policy.metadata,
    });
  }
  for (const policyId of createdPolicyIds) {
    if (typeof policyId !== "string") continue;
    await updateReminderPolicy({
      userId: params.userId,
      policyId,
      status: "cancelled",
      nextFireAt: null,
      metadata: { cancelledByUndo: true },
    });
    await cancelPendingRemindersForPolicy({ userId: params.userId, policyId });
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
      action.actionType === "item_edit_apply"
        ? "Вернул предыдущие поля записи и связанных правил напоминаний."
        : "Напоминания, которые уже были отменены при удалении, нужно будет поставить заново, если они еще нужны.",
    ].join("\n"),
    affectedItemIds: restored.map((item) => item.id),
  };
}

function parseUndoDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeUndoItemSnapshot<T extends {
  kind?: string;
  status?: string;
  title?: string;
  startAt?: string | null;
  endAt?: string | null;
  visibility?: string | null;
  metadata?: Record<string, unknown>;
}>(item: T): T {
  if (
    item.status === "active" &&
    item.kind === "task" &&
    item.startAt &&
    isEventLikeScheduledTitle(item.title ?? "")
  ) {
    return {
      ...item,
      kind: "event",
      visibility: item.visibility === "history" ? "active" : item.visibility,
      metadata: {
        ...(item.metadata ?? {}),
        undoKindNormalized: true,
        undoKindNormalizedBy: "v2130",
      },
    };
  }
  return item;
}

function isEventLikeScheduledTitle(title: string) {
  return /(визит|при[её]м|ортодонт|встреча|созвон|эфир|запись|матч|комментар|комментир)/i.test(
    title,
  );
}

export function parseDisplayIndexSelection(text: string): number[] {
  const withoutTimes = text
    .replace(/\b\d{1,2}[.:]\d{2}\s*[-–—]\s*\d{1,2}[.:]\d{2}\b/g, " ")
    .replace(/\b\d{1,2}[.:]\d{2}\b/g, " ");
  const indices: number[] = [];
  for (const match of withoutTimes.matchAll(/\b(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?\b/g)) {
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
  return resolveItemsFromView(userId, viewState, indices);
}

async function resolveItemsFromView(
  userId: string,
  viewState: TaskViewState | null,
  indices: number[],
) {
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
  const pinned: PlannerItem[] = [];
  const notes: PlannerItem[] = [];
  for (const item of sortJarvisItemsForDisplay(items)) {
    const when = item.startAt ?? item.dueAt;
    if (isPinnedContextNote(item)) pinned.push(item);
    else if (item.kind === "recurring_task") recurring.push(item);
    else if (item.kind === "training") training.push(item);
    else if (item.kind === "note") notes.push(item);
    else if (when && when < now) overdue.push(item);
    else if (!when || item.metadata?.isFloating === true || item.metadata?.timeUnspecified === true) floating.push(item);
    else scheduled.push(item);
  }
  return [
    { title: "Закреплено", items: pinned },
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

export function parseDeleteIndexSelection(text: string): number[] {
  const deleteStart = text.search(/удал(?:и|ить|яй)|убери|отмени|стереть/i);
  if (deleteStart < 0) return [];
  const tail = text.slice(deleteStart);
  const nextOperation = tail.slice(1).search(/поменяй|измени|перенеси|отметь|сделай/i);
  const selectionText = nextOperation >= 0 ? tail.slice(0, nextOperation + 1) : tail;
  return parseDisplayIndexSelection(selectionText);
}

function parseScheduleChange(text: string) {
  const match = text.match(
    /(?:поменяй|измени|перенеси)\s+(\d{1,3}).{0,50}?(\d{1,2})[.:](\d{2})\s*[-–—]\s*(\d{1,2})[.:](\d{2})/i,
  );
  if (!match) return null;
  return {
    index: Number(match[1]),
    startTime: `${match[2].padStart(2, "0")}:${match[3]}`,
    endTime: `${match[4].padStart(2, "0")}:${match[5]}`,
  };
}

function applyClock(date: DateTime, time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return date.set({ hour, minute, second: 0, millisecond: 0 });
}

function duplicateItemIds(items: PlannerItem[]) {
  const groups = new Map<string, PlannerItem[]>();
  for (const item of items) {
    const anchor = item.startAt ?? item.dueAt;
    const key = `${item.title.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim()}|${anchor?.toISOString().slice(0, 10) ?? "floating"}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return new Set(
    [...groups.values()]
      .filter((group) => group.length > 1)
      .flatMap((group) =>
        [...group]
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(1)
          .map((item) => item.id),
      ),
  );
}

function garbageReason(item: PlannerItem, duplicates: Set<string>, now: Date) {
  if (isGarbageOrTestItem(item)) return "malformed/test/known garbage";
  if (duplicates.has(item.id)) return "duplicate normalized title/date";
  const anchor = item.startAt ?? item.dueAt;
  if (anchor && anchor.getTime() < now.getTime() - 48 * 60 * 60 * 1000) {
    return "stale unresolved older than 48h";
  }
  return "needs review";
}
