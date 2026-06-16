import { InlineKeyboard } from "grammy";
import { DateTime } from "luxon";

import type { ActionPlanItem } from "@/ai/schemas";
import type { AgentExecution, AgentReminderPolicy } from "@/ai/schemas/agentExecution";
import {
  getAgentActionById,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import {
  createManualPlannerItem,
  getPlannerItemById,
  listManageableItems,
} from "@/db/queries/items";
import type { AgentAction, PlannerItem } from "@/db/schema";
import { parseBeforeEventReminderSpecsForAnchor } from "@/domain/beforeEventReminderParsing";
import { formatRuWeekdayDateTime, localIsoToUtcDate } from "@/domain/dateTime";
import { formatBeforeEventOffset } from "@/domain/reminderPolicyPresentation";
import {
  applyItemEditMutation,
  type ItemEditApplyResult,
  type ItemEditMutation,
} from "@/services/itemEditMutations";

export type TargetResolutionDecision =
  | "rename"
  | "reminders_only"
  | "create_separate"
  | "manual"
  | "cancel";

export type EventTargetCandidate = {
  itemId: string;
  title: string;
  startAt: string;
  endAt: string | null;
  similarityScore: number;
  matchedEntities: string[];
  conflictType: "same_slot_similar_title" | "same_entity_different_title" | "overlap_similar_title";
};

export type StoredBeforeEventReminder = {
  fireAtLocal: string;
  minutesBefore: number;
  label: string;
};

export type ProposedEvent = {
  title: string;
  kind: string;
  startAtLocal: string;
  endAtLocal: string | null;
  timezone: string;
  durationMinutes: number | null;
  reminders: StoredBeforeEventReminder[];
  reminderMode: "add" | "replace";
};

export type EventTargetResolutionSession = {
  kind: "event_target_resolution";
  createdAt: string;
  expiresAt: string;
  originalText: string;
  proposedEvent: ProposedEvent;
  candidates: EventTargetCandidate[];
  defaultAction: "ask";
};

export type ReminderTargetResolutionSession = {
  kind: "reminder_target_resolution";
  createdAt: string;
  expiresAt: string;
  originalText: string;
  reminders: StoredBeforeEventReminder[];
  reminderMode: "add" | "replace";
  candidates: EventTargetCandidate[];
  defaultAction: "ask";
};

const EVENT_SESSION_TYPE = "event_target_resolution";
const REMINDER_SESSION_TYPE = "reminder_target_resolution";
const TTL_MINUTES = 20;

export function extractProposedEventFromExecution(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}): ProposedEvent | null {
  const actions = params.execution.actionPlan?.actions ?? [];
  const eventActions = actions.filter(isEventLikeAction);
  if (eventActions.length !== 1) return null;
  const action = eventActions[0];
  if (!action.title || !action.startAtLocal) return null;
  const reminders = extractReminderSpecs({
    action,
    policies: params.execution.reminderPolicies,
    timezone: action.timezone || params.timezone,
    now: params.now,
  });
  return {
    title: action.title,
    kind: action.kind,
    startAtLocal: action.startAtLocal,
    endAtLocal: action.endAtLocal,
    timezone: action.timezone || params.timezone,
    durationMinutes: action.durationMinutes,
    reminders,
    reminderMode: textAsksReplace(params.text) ? "replace" : "add",
  };
}

export function extractProposedEventFromTargetedUpdate(params: {
  execution: AgentExecution;
  text: string;
  item: PlannerItem;
  timezone: string;
}) {
  if (hasExplicitUpdateReference(params.text)) return null;
  if (!["event", "training", "tentative_event"].includes(params.item.kind)) return null;
  const title = extractLeadingEventTitle(params.text);
  if (!title || normalizeTitle(title) === normalizeTitle(params.item.title)) return null;
  const anchor = params.item.startAt ?? params.item.dueAt;
  if (!anchor) return null;
  const timezone = params.item.timezone || params.timezone;
  const update = params.execution.itemUpdates.find((entry) =>
    entry.itemIds.includes(params.item.id),
  );
  const startAtLocal =
    update?.startAtLocal ??
    DateTime.fromJSDate(anchor, { zone: "utc" })
      .setZone(timezone)
      .toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const endAtLocal =
    update?.endAtLocal ??
    (params.item.endAt
      ? DateTime.fromJSDate(params.item.endAt, { zone: "utc" })
          .setZone(timezone)
          .toFormat("yyyy-MM-dd'T'HH:mm:ss")
      : null);
  const reminders: StoredBeforeEventReminder[] = [];
  if (update?.reminderMinutesBefore) {
    const fireAt = localIsoToUtcDate(startAtLocal, timezone);
    const local = DateTime.fromJSDate(fireAt, { zone: "utc" })
      .minus({ minutes: update.reminderMinutesBefore })
      .setZone(timezone);
    reminders.push({
      fireAtLocal: local.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      minutesBefore: update.reminderMinutesBefore,
      label: formatBeforeEventOffset(update.reminderMinutesBefore),
    });
  }
  for (const policy of params.execution.reminderPolicies) {
    if (policy.policyType !== "before_event") continue;
    if (policy.itemIds.length && !policy.itemIds.includes(params.item.id)) continue;
    const minutes = policy.minutesBefore;
    const fireAtLocal = policy.nextFireAtLocal ?? policy.startsAtLocal;
    if (!minutes || !fireAtLocal) continue;
    reminders.push({
      fireAtLocal,
      minutesBefore: minutes,
      label: formatBeforeEventOffset(minutes),
    });
  }
  const deduped = new Map<number, StoredBeforeEventReminder>();
  for (const reminder of reminders) deduped.set(reminder.minutesBefore, reminder);
  return {
    title,
    kind: params.item.kind,
    startAtLocal,
    endAtLocal,
    timezone,
    durationMinutes:
      params.item.startAt && params.item.endAt
        ? Math.round((params.item.endAt.getTime() - params.item.startAt.getTime()) / 60_000)
        : null,
    reminders: [...deduped.values()],
    reminderMode: textAsksReplace(params.text) ? "replace" : "add",
  } satisfies ProposedEvent;
}

export async function findAmbiguousEventTargets(params: {
  userId: string;
  proposedEvent: ProposedEvent;
  originalText: string;
  timezone: string;
  now: Date;
}) {
  if (hasExplicitUpdateReference(params.originalText)) return [];
  const proposedStart = localIsoToUtcDate(
    params.proposedEvent.startAtLocal,
    params.proposedEvent.timezone,
  );
  const proposedEnd = params.proposedEvent.endAtLocal
    ? localIsoToUtcDate(params.proposedEvent.endAtLocal, params.proposedEvent.timezone)
    : new Date(proposedStart.getTime() + (params.proposedEvent.durationMinutes ?? 60) * 60_000);
  const proposedTitle = normalizeTitle(params.proposedEvent.title);
  const items = await listManageableItems(params.userId, 300);
  return items
    .filter((item) => isFutureEventLike(item, params.now))
    .map((item) =>
      ambiguousEventCandidateForItem({
        item,
        proposedEvent: params.proposedEvent,
        proposedStart,
        proposedEnd,
        proposedTitle,
      }),
    )
    .filter((candidate): candidate is EventTargetCandidate => Boolean(candidate))
    .sort((left, right) => right.similarityScore - left.similarityScore)
    .slice(0, 5);
}

export function ambiguousEventCandidateForItem(params: {
  item: PlannerItem;
  proposedEvent: ProposedEvent;
  proposedStart: Date;
  proposedEnd: Date;
  proposedTitle?: string;
}): EventTargetCandidate | null {
  const start = params.item.startAt ?? params.item.dueAt;
  if (!start) return null;
  const end = params.item.endAt ?? new Date(start.getTime() + 60 * 60_000);
  const slotDistance = Math.abs(start.getTime() - params.proposedStart.getTime());
  const overlaps = params.proposedStart < end && params.proposedEnd > start;
  const sameSlot = slotDistance <= 15 * 60_000;
  if (!sameSlot && !overlaps) return null;
  const title = normalizeTitle(params.item.title);
  const proposedTitle = params.proposedTitle ?? normalizeTitle(params.proposedEvent.title);
  if (title === proposedTitle) return null;
  const matchedEntities = commonStrongEntities(params.item.title, params.proposedEvent.title);
  const similarityScore = titleSimilarity(title, proposedTitle);
  if (!matchedEntities.length && similarityScore < 0.42) return null;
  return {
    itemId: params.item.id,
    title: params.item.title,
    startAt: start.toISOString(),
    endAt: params.item.endAt?.toISOString() ?? null,
    similarityScore,
    matchedEntities,
    conflictType: sameSlot
      ? matchedEntities.length
        ? "same_entity_different_title"
        : "same_slot_similar_title"
      : "overlap_similar_title",
  };
}

export async function startEventTargetResolutionSession(params: {
  userId: string;
  sourceMessageId?: string | null;
  originalText: string;
  proposedEvent: ProposedEvent;
  candidates: EventTargetCandidate[];
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const expiresAt = DateTime.fromJSDate(now, { zone: "utc" }).plus({ minutes: TTL_MINUTES });
  return recordAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: EVENT_SESSION_TYPE,
    status: "pending",
    input: {
      originalText: params.originalText.slice(0, 1600),
      proposedEvent: params.proposedEvent,
      candidates: params.candidates,
    },
    output: {
      kind: EVENT_SESSION_TYPE,
      activeSessionType: EVENT_SESSION_TYPE,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISO(),
      defaultAction: "ask",
      proposedEvent: params.proposedEvent,
      candidates: params.candidates,
    },
  });
}

export async function startReminderTargetResolutionSession(params: {
  userId: string;
  sourceMessageId?: string | null;
  originalText: string;
  reminders: StoredBeforeEventReminder[];
  reminderMode: "add" | "replace";
  candidates: EventTargetCandidate[];
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const expiresAt = DateTime.fromJSDate(now, { zone: "utc" }).plus({ minutes: TTL_MINUTES });
  return recordAgentAction({
    userId: params.userId,
    sourceMessageId: params.sourceMessageId,
    actionType: REMINDER_SESSION_TYPE,
    status: "pending",
    input: {
      originalText: params.originalText.slice(0, 1600),
      reminders: params.reminders,
      candidates: params.candidates,
    },
    output: {
      kind: REMINDER_SESSION_TYPE,
      activeSessionType: REMINDER_SESSION_TYPE,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISO(),
      defaultAction: "ask",
      reminderMode: params.reminderMode,
      reminders: params.reminders,
      candidates: params.candidates,
    },
  });
}

export async function getEventTargetResolutionSession(params: {
  userId: string;
  actionId: string;
  now?: Date;
}) {
  const action = await getAgentActionById({ userId: params.userId, actionId: params.actionId });
  if (!action || action.actionType !== EVENT_SESSION_TYPE || action.status !== "pending") {
    return null;
  }
  const session = parseEventSession(action);
  if (!session || new Date(session.expiresAt) <= (params.now ?? new Date())) {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: { ...(action.output ?? {}), cancelledReason: "expired_or_invalid" },
    });
    return null;
  }
  return { action, session };
}

export async function getReminderTargetResolutionSession(params: {
  userId: string;
  actionId: string;
  now?: Date;
}) {
  const action = await getAgentActionById({ userId: params.userId, actionId: params.actionId });
  if (!action || action.actionType !== REMINDER_SESSION_TYPE || action.status !== "pending") {
    return null;
  }
  const session = parseReminderSession(action);
  if (!session || new Date(session.expiresAt) <= (params.now ?? new Date())) {
    await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: { ...(action.output ?? {}), cancelledReason: "expired_or_invalid" },
    });
    return null;
  }
  return { action, session };
}

export async function finishTargetResolutionAction(params: {
  userId: string;
  action: AgentAction;
  status: "completed" | "cancelled" | "failed";
  details?: Record<string, unknown>;
}) {
  return updateAgentAction({
    userId: params.userId,
    actionId: params.action.id,
    status: params.status,
    output: {
      ...(params.action.output ?? {}),
      ...(params.details ?? {}),
      completedAt: params.status === "completed" ? new Date().toISOString() : undefined,
      cancelledAt: params.status === "cancelled" ? new Date().toISOString() : undefined,
    },
  });
}

export async function applyReminderSpecsToItem(params: {
  userId: string;
  item: PlannerItem;
  reminders: StoredBeforeEventReminder[];
  mode: "add" | "replace";
  timezone: string;
  sourceMessageId?: string | null;
  now?: Date;
  title?: string | null;
  mutationSource?: string;
}): Promise<ItemEditApplyResult> {
  const mutation: ItemEditMutation = {
    itemId: params.item.id,
    ...(params.title && params.title !== params.item.title ? { title: params.title } : {}),
    reminderPolicy: {
      policyType: "before_event_multi",
      reminders: params.reminders,
      mode: params.mode,
      mutationSource: params.mutationSource ?? "event_target_resolution",
    },
    changedFields: [
      ...(params.title && params.title !== params.item.title ? ["title"] : []),
      "reminder_policy",
    ],
    warnings: [],
    pastConfirmationRequired: false,
  };
  return applyItemEditMutation({
    userId: params.userId,
    item: params.item,
    mutation,
    timezone: params.timezone,
    sourceMessageId: params.sourceMessageId,
    now: params.now,
  });
}

export async function createSeparateEventFromSession(params: {
  userId: string;
  proposedEvent: ProposedEvent;
  sourceMessageId?: string | null;
  now?: Date;
}) {
  const startAt = localIsoToUtcDate(
    params.proposedEvent.startAtLocal,
    params.proposedEvent.timezone,
  );
  const endAt = params.proposedEvent.endAtLocal
    ? localIsoToUtcDate(params.proposedEvent.endAtLocal, params.proposedEvent.timezone)
    : new Date(startAt.getTime() + (params.proposedEvent.durationMinutes ?? 60) * 60_000);
  const item = await createManualPlannerItem({
    userId: params.userId,
    kind: params.proposedEvent.kind || "event",
    title: params.proposedEvent.title,
    timezone: params.proposedEvent.timezone,
    startAt,
    endAt,
    dueAt: null,
    category: params.proposedEvent.kind === "training" ? "training" : "event",
    metadata: {
      createdBy: "event_target_resolution",
      sourceMessageId: params.sourceMessageId ?? null,
      conflictWarning: true,
    },
  });
  const reminderResult = params.proposedEvent.reminders.length
    ? await applyReminderSpecsToItem({
        userId: params.userId,
        item,
        reminders: params.proposedEvent.reminders,
        mode: params.proposedEvent.reminderMode,
        timezone: params.proposedEvent.timezone,
        sourceMessageId: params.sourceMessageId,
        now: params.now,
      })
    : null;
  return { item, reminderResult };
}

export function targetResolutionKeyboard(actionId: string) {
  return new InlineKeyboard()
    .text("✅ Обновить название и напоминания", `tr:rename:${actionId}:0`)
    .row()
    .text("🔔 Оставить название, обновить напоминания", `tr:rem:${actionId}:0`)
    .row()
    .text("➕ Создать отдельно", `tr:create:${actionId}`)
    .row()
    .text("✏️ Показать варианты", `tr:manual:${actionId}`)
    .text("❌ Отмена", `tr:cancel:${actionId}`);
}

export function reminderTargetKeyboard(actionId: string, count: number) {
  const keyboard = new InlineKeyboard();
  for (let index = 0; index < Math.min(count, 8); index += 1) {
    keyboard.text(String(index + 1), `trrem:pick:${actionId}:${index}`);
    if ((index + 1) % 4 === 0) keyboard.row();
  }
  if (count % 4 !== 0) keyboard.row();
  return keyboard.text("❌ Отмена", `trrem:cancel:${actionId}`);
}

export function formatTargetResolutionPrompt(params: {
  proposedEvent: ProposedEvent;
  candidates: EventTargetCandidate[];
  timezone: string;
}) {
  return [
    "Похоже, уже есть похожее событие:",
    "",
    ...params.candidates.map((candidate, index) => {
      const start = new Date(candidate.startAt);
      return `${index + 1}. ${candidate.title} — ${formatRuWeekdayDateTime(start, params.timezone)}`;
    }),
    "",
    "Новый запрос:",
    `${params.proposedEvent.title} — ${formatRuWeekdayDateTime(
      localIsoToUtcDate(params.proposedEvent.startAtLocal, params.proposedEvent.timezone),
      params.proposedEvent.timezone,
    )}`,
    params.proposedEvent.reminders.length
      ? `Напоминания: ${params.proposedEvent.reminders.map((reminder) => reminder.label).join(", ")}`
      : null,
    "",
    "Что сделать?",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatReminderTargetPrompt(params: {
  reminders: StoredBeforeEventReminder[];
  candidates: EventTargetCandidate[];
  timezone: string;
}) {
  return [
    "К какому событию добавить напоминания?",
    "",
    ...params.candidates.map((candidate, index) => {
      const start = new Date(candidate.startAt);
      return `${index + 1}. ${candidate.title} — ${formatRuWeekdayDateTime(start, params.timezone)}`;
    }),
    "",
    `Напоминания: ${params.reminders.map((reminder) => reminder.label).join(", ")}`,
  ].join("\n");
}

export function candidateFromItem(item: PlannerItem, score = 1): EventTargetCandidate {
  const start = item.startAt ?? item.dueAt;
  return {
    itemId: item.id,
    title: item.title,
    startAt: start?.toISOString() ?? item.createdAt.toISOString(),
    endAt: item.endAt?.toISOString() ?? null,
    similarityScore: score,
    matchedEntities: [],
    conflictType: "same_slot_similar_title",
  };
}

function extractReminderSpecs(params: {
  action: ActionPlanItem;
  policies: AgentReminderPolicy[];
  timezone: string;
  now: Date;
}) {
  const specs: StoredBeforeEventReminder[] = [];
  for (const reminder of params.action.reminders) {
    if (!reminder.scheduledAtLocal || !reminder.offsetMinutesBefore) continue;
    specs.push({
      fireAtLocal: reminder.scheduledAtLocal,
      minutesBefore: reminder.offsetMinutesBefore,
      label: formatBeforeEventOffset(reminder.offsetMinutesBefore),
    });
  }
  for (const policy of params.policies) {
    if (policy.policyType !== "before_event") continue;
    if (
      policy.itemTitle &&
      normalizeTitle(policy.itemTitle) !== normalizeTitle(params.action.title)
    ) {
      continue;
    }
    const minutes = policy.minutesBefore;
    const fireAtLocal = policy.nextFireAtLocal ?? policy.startsAtLocal;
    if (!minutes || !fireAtLocal) continue;
    specs.push({
      fireAtLocal,
      minutesBefore: minutes,
      label: formatBeforeEventOffset(minutes),
    });
  }
  if (!specs.length && params.action.startAtLocal) {
    const anchor = localIsoToUtcDate(params.action.startAtLocal, params.timezone);
    const parsed = parseBeforeEventReminderSpecsForAnchor({
      text: params.action.description ?? "",
      anchor,
      timezone: params.timezone,
      now: params.now,
      allowAbsoluteTimes: false,
      includePast: true,
    });
    specs.push(...parsed.reminders);
  }
  const seen = new Set<number>();
  return specs.filter((spec) => {
    if (seen.has(spec.minutesBefore)) return false;
    seen.add(spec.minutesBefore);
    return true;
  });
}

function isEventLikeAction(action: ActionPlanItem) {
  return ["event", "training", "tentative_event"].includes(action.kind);
}

function isFutureEventLike(item: PlannerItem, now: Date) {
  if (!["event", "training", "tentative_event"].includes(item.kind)) return false;
  const anchor = item.startAt ?? item.dueAt;
  return Boolean(anchor && anchor > now && item.status === "active");
}

export function hasExplicitUpdateReference(text: string) {
  return /(это|этот|его|тот|та же|тот же|замени|обнови|переименуй|исправь|rename|update|replace)/i.test(
    text,
  );
}

function textAsksReplace(text: string) {
  return /(замени|вместо|оставь только|replace)/i.test(text);
}

function normalizeTitle(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function titleSimilarity(left: string, right: string) {
  const leftTokens = new Set(left.split(/\s+/).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/).filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function commonStrongEntities(left: string, right: string) {
  const leftTokens = entityTokens(left);
  const rightTokens = entityTokens(right);
  return [...leftTokens].filter((token) => rightTokens.has(token));
}

function entityTokens(value: string) {
  const tokens = normalizeTitle(value)
    .split(/\s+/)
    .filter((token) => token.length >= 4 || /^[A-ZА-Я]{2,}$/i.test(token));
  return new Set(tokens);
}

function extractLeadingEventTitle(text: string) {
  const cleaned = text
    .split(/(?:напомни|напоминание|поставь напомин)/i)[0]
    .replace(/\s+/g, " ")
    .trim();
  const title = cleaned
    .split(
      /\s+(?:сегодня|завтра|послезавтра|в\s+\d{1,2}(?:[.:]\d{2})?|на\s+\d{1,2})(?:\s|[,.]|$)/i,
    )[0]
    ?.replace(/[,.]+$/g, "")
    .trim();
  if (!title || title.length < 6) return null;
  if (!/(созвон|встреч|эфир|запись|матч|тренировк|studio|central|winline|винлайн)/i.test(title)) {
    return null;
  }
  return title;
}

function parseEventSession(action: AgentAction): EventTargetResolutionSession | null {
  const output = action.output ?? {};
  if (output.kind !== EVENT_SESSION_TYPE) return null;
  const proposedEvent = output.proposedEvent;
  const candidates = output.candidates;
  const expiresAt = output.expiresAt;
  if (!isRecord(proposedEvent) || !Array.isArray(candidates) || typeof expiresAt !== "string") {
    return null;
  }
  return {
    kind: EVENT_SESSION_TYPE,
    createdAt: String(output.createdAt ?? action.createdAt.toISOString()),
    expiresAt,
    originalText: String(action.input?.originalText ?? ""),
    proposedEvent: proposedEvent as ProposedEvent,
    candidates: candidates as EventTargetCandidate[],
    defaultAction: "ask",
  };
}

function parseReminderSession(action: AgentAction): ReminderTargetResolutionSession | null {
  const output = action.output ?? {};
  if (output.kind !== REMINDER_SESSION_TYPE) return null;
  const reminders = output.reminders;
  const candidates = output.candidates;
  const expiresAt = output.expiresAt;
  if (!Array.isArray(reminders) || !Array.isArray(candidates) || typeof expiresAt !== "string") {
    return null;
  }
  return {
    kind: REMINDER_SESSION_TYPE,
    createdAt: String(output.createdAt ?? action.createdAt.toISOString()),
    expiresAt,
    originalText: String(action.input?.originalText ?? ""),
    reminders: reminders as StoredBeforeEventReminder[],
    reminderMode: output.reminderMode === "replace" ? "replace" : "add",
    candidates: candidates as EventTargetCandidate[],
    defaultAction: "ask",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function itemForCandidate(params: {
  userId: string;
  candidate: EventTargetCandidate;
}) {
  return getPlannerItemById(params.userId, params.candidate.itemId);
}
