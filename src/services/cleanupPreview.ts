import {
  cleanupConfirmationKeyboard,
  cleanupPreviewKeyboard,
  type CleanupCategory,
} from "@/bot/keyboards";
import {
  getAgentActionById,
  listPendingAgentActionsByTypes,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import {
  archiveCompletedPlannerItem,
  listCompletedPlannerItems,
} from "@/db/queries/items";
import {
  listActiveReminderPolicies,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelPendingRemindersForPolicy } from "@/db/queries/reminders";
import { listActiveMessages } from "@/db/queries/telegramMessageRegistry";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";

const TRANSIENT_PURPOSES = [
  "item_menu",
  "reminder",
  "followup",
  "confirmation",
  "transient_status",
  "policy_editor",
];
const CLEANUP_DRAFT_TYPES = [
  "recurring_policy_draft",
  "recurring_policy_duplicate_decision",
  "item_edit_session",
  "reminder_policy_edit_session",
  "reminder_policy_setup_session",
];
const COMPLETED_RETENTION_DAYS = 30;
const DRAFT_STALE_HOURS = 24;

type CleanupInventory = {
  messages: number;
  completedItemIds: string[];
  draftActionIds: string[];
  brokenPolicyIds: string[];
};

export async function renderCleanupPreview(params: {
  userId: string;
  chatId: string;
  category?: CleanupCategory;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const inventory = await buildCleanupInventory({
    userId: params.userId,
    chatId: params.chatId,
    now,
  });
  const counts = cleanupCounts(inventory);
  if (!params.category) {
    return {
      text: [
        "🧹 Что очистить?",
        "",
        `1. Сообщения JARVIS в чате: ${counts.messages}`,
        `2. Выполненные задачи старше ${COMPLETED_RETENTION_DAYS} дней: ${counts.completed}`,
        `3. Устаревшие черновики: ${counts.drafts}`,
        `4. Сломанные напоминания: ${counts.broken}`,
        "",
        "Ничего не удаляю без preview и подтверждения.",
        "Задачи, события и Яндекс.Календарь при очистке чата не изменяются.",
      ].join("\n"),
      keyboard: cleanupPreviewKeyboard(params.chatId, counts),
      counts,
    };
  }

  const selection = selectCleanupInventory(inventory, params.category);
  const action = await recordAgentAction({
    userId: params.userId,
    actionType: "cleanup_preview",
    status: "pending",
    input: {
      category: params.category,
      chatId: params.chatId,
    },
    output: {
      category: params.category,
      chatId: params.chatId,
      messageCount: selection.messages,
      completedItemIds: selection.completedItemIds,
      draftActionIds: selection.draftActionIds,
      brokenPolicyIds: selection.brokenPolicyIds,
      calendarObjectsToChange: 0,
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    },
  });
  return {
    text: formatCleanupCategoryPreview(params.category, selection),
    keyboard: action ? cleanupConfirmationKeyboard(action.id, params.category) : undefined,
    counts,
    actionId: action?.id ?? null,
  };
}

export async function getCleanupPreviewSession(params: {
  userId: string;
  actionId: string;
  now?: Date;
}) {
  const action = await getAgentActionById(params);
  if (!action || action.actionType !== "cleanup_preview" || action.status !== "pending") return null;
  const expiresAt = parseDate(action.output?.expiresAt);
  if (!expiresAt || expiresAt <= (params.now ?? new Date())) {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: { ...(action.output ?? {}), cancelledReason: "expired_cleanup_preview" },
    });
    return null;
  }
  const category = action.output?.category;
  const chatId = action.output?.chatId;
  if (!isCleanupCategory(category) || typeof chatId !== "string") return null;
  return {
    action,
    category,
    chatId,
    messageCount: numberValue(action.output?.messageCount),
    completedItemIds: stringArray(action.output?.completedItemIds),
    draftActionIds: stringArray(action.output?.draftActionIds),
    brokenPolicyIds: stringArray(action.output?.brokenPolicyIds),
  };
}

export async function applyCleanupPreviewSession(params: {
  userId: string;
  actionId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const session = await getCleanupPreviewSession(params);
  if (!session) return null;
  let archivedCompleted = 0;
  let cancelledDrafts = 0;
  let cancelledBrokenPolicies = 0;

  for (const itemId of session.completedItemIds) {
    if (await archiveCompletedPlannerItem({ userId: params.userId, itemId })) {
      archivedCompleted += 1;
    }
  }
  for (const actionId of session.draftActionIds) {
    const action = await getAgentActionById({ userId: params.userId, actionId });
    if (!action || action.status !== "pending") continue;
    if (
      await updateAgentAction({
        userId: params.userId,
        actionId,
        status: "cancelled",
        output: {
          ...(action.output ?? {}),
          cancelledReason: "cleanup_stale_draft",
          cleanupAt: now.toISOString(),
        },
      })
    ) {
      cancelledDrafts += 1;
    }
  }
  for (const policyId of session.brokenPolicyIds) {
    await cancelPendingRemindersForPolicy({ userId: params.userId, policyId, from: now });
    if (
      await updateReminderPolicy({
        userId: params.userId,
        policyId,
        status: "cancelled",
        nextFireAt: null,
        metadata: {
          cancelledBy: "cleanup_broken_reminder",
          cancelledAt: now.toISOString(),
        },
      })
    ) {
      cancelledBrokenPolicies += 1;
    }
  }
  await updateAgentAction({
    userId: params.userId,
    actionId: session.action.id,
    status: "completed",
    output: {
      ...(session.action.output ?? {}),
      archivedCompleted,
      cancelledDrafts,
      cancelledBrokenPolicies,
      calendarObjectsChanged: 0,
      completedAt: now.toISOString(),
    },
  });
  return {
    ...session,
    archivedCompleted,
    cancelledDrafts,
    cancelledBrokenPolicies,
    calendarObjectsChanged: 0,
  };
}

export async function cancelCleanupPreviewSession(params: {
  userId: string;
  actionId: string;
}) {
  const action = await getAgentActionById(params);
  if (!action || action.actionType !== "cleanup_preview" || action.status !== "pending") return null;
  return updateAgentAction({
    userId: params.userId,
    actionId: action.id,
    status: "cancelled",
    output: {
      ...(action.output ?? {}),
      cancelledReason: "user_cancelled_cleanup",
      cancelledAt: new Date().toISOString(),
    },
  });
}

export function isCleanupEligibleCompleted(item: PlannerItem, now: Date) {
  if (item.status !== "completed" || item.visibility === "history") return false;
  const completedAt = item.completedAt ?? item.updatedAt;
  return completedAt.getTime() <= now.getTime() - COMPLETED_RETENTION_DAYS * 24 * 60 * 60_000;
}

export function isCleanupEligibleDraft(action: AgentAction, now: Date) {
  if (action.status !== "pending" || !CLEANUP_DRAFT_TYPES.includes(action.actionType)) return false;
  const expiresAt = parseDate(action.output?.expiresAt);
  if (expiresAt) return expiresAt <= now;
  return action.createdAt.getTime() <= now.getTime() - DRAFT_STALE_HOURS * 60 * 60_000;
}

export function isCleanupEligibleBrokenPolicy(policy: ReminderPolicy) {
  if (policy.status !== "active") return false;
  return (
    policy.metadata?.needsReview === true ||
    policy.metadata?.invalidRecurrence === true ||
    policy.metadata?.orphanPolicy === true ||
    policy.metadata?.broken === true
  );
}

async function buildCleanupInventory(params: {
  userId: string;
  chatId: string;
  now: Date;
}): Promise<CleanupInventory> {
  const [transient, completed, drafts, policies] = await Promise.all([
    listActiveMessages({
      userId: params.userId,
      chatId: params.chatId,
      purposes: TRANSIENT_PURPOSES,
      limit: 200,
    }),
    listCompletedPlannerItems({ userId: params.userId, limit: 500 }),
    listPendingAgentActionsByTypes({
      userId: params.userId,
      actionTypes: CLEANUP_DRAFT_TYPES,
      limit: 300,
    }),
    listActiveReminderPolicies(params.userId, 500),
  ]);
  return {
    messages: transient.length,
    completedItemIds: completed
      .filter((item) => isCleanupEligibleCompleted(item, params.now))
      .map((item) => item.id),
    draftActionIds: drafts
      .filter((action) => isCleanupEligibleDraft(action, params.now))
      .map((action) => action.id),
    brokenPolicyIds: policies.filter(isCleanupEligibleBrokenPolicy).map((policy) => policy.id),
  };
}

function selectCleanupInventory(
  inventory: CleanupInventory,
  category: CleanupCategory,
): CleanupInventory {
  return {
    messages: category === "messages" || category === "all" ? inventory.messages : 0,
    completedItemIds:
      category === "completed" || category === "all" ? inventory.completedItemIds : [],
    draftActionIds: category === "drafts" || category === "all" ? inventory.draftActionIds : [],
    brokenPolicyIds:
      category === "broken" || category === "all" ? inventory.brokenPolicyIds : [],
  };
}

function cleanupCounts(inventory: CleanupInventory) {
  const counts = {
    messages: inventory.messages,
    completed: inventory.completedItemIds.length,
    drafts: inventory.draftActionIds.length,
    broken: inventory.brokenPolicyIds.length,
    all: 0,
  };
  counts.all = counts.messages + counts.completed + counts.drafts + counts.broken;
  return counts;
}

function formatCleanupCategoryPreview(
  category: CleanupCategory,
  inventory: CleanupInventory,
) {
  const lines = [
    `🧹 Preview: ${cleanupCategoryLabel(category)}`,
    "",
    inventory.messages ? `Из Telegram-чата будет убрано сообщений: ${inventory.messages}` : null,
    inventory.completedItemIds.length
      ? `Будет архивировано выполненных задач старше ${COMPLETED_RETENTION_DAYS} дней: ${inventory.completedItemIds.length}`
      : null,
    inventory.draftActionIds.length
      ? `Будет отменено устаревших черновиков: ${inventory.draftActionIds.length}`
      : null,
    inventory.brokenPolicyIds.length
      ? `Будет отключено сломанных напоминаний: ${inventory.brokenPolicyIds.length}`
      : null,
    !inventory.messages &&
    !inventory.completedItemIds.length &&
    !inventory.draftActionIds.length &&
    !inventory.brokenPolicyIds.length
      ? "Подходящих записей нет."
      : null,
    "",
    "Активные задачи и события не удаляются.",
    "Яндекс.Календарь: 0 изменений.",
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

function cleanupCategoryLabel(category: CleanupCategory) {
  if (category === "messages") return "сообщения JARVIS";
  if (category === "completed") return "старые выполненные задачи";
  if (category === "drafts") return "устаревшие черновики";
  if (category === "broken") return "сломанные напоминания";
  return "все безопасные категории";
}

function isCleanupCategory(value: unknown): value is CleanupCategory {
  return ["messages", "completed", "drafts", "broken", "all"].includes(String(value));
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
