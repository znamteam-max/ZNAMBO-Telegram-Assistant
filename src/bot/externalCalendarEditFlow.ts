import { DateTime } from "luxon";

import {
  getLatestAgentActionByStatus,
  recordAgentAction,
  updateAgentAction,
} from "@/db/queries/agentActions";
import {
  getExternalCalendarEventById,
  upsertExternalCalendarEvent,
} from "@/db/queries/externalCalendarEvents";
import type { ExternalCalendarEvent, PlannerItem } from "@/db/schema";
import {
  classifyYandexCalendarError,
  updateYandexCalendarObject,
} from "@/integrations/yandexCalendar";
import { parseItemEditMutation } from "@/services/itemEditMutations";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { replyAndRecord } from "./reply";

const ACTION_TYPE = "external_calendar_edit_session";
const TTL_MINUTES = 30;

export async function startExternalCalendarEditSession(params: {
  userId: string;
  eventId: string;
  sourceTelegramMessageId?: number | null;
  now?: Date;
}) {
  await clearExternalCalendarEditSession({ userId: params.userId, reason: "replaced" });
  const now = params.now ?? new Date();
  return recordAgentAction({
    userId: params.userId,
    actionType: ACTION_TYPE,
    status: "pending",
    input: {
      externalEventId: params.eventId,
      sourceTelegramMessageId: params.sourceTelegramMessageId ?? null,
    },
    output: {
      externalEventId: params.eventId,
      expiresAt: DateTime.fromJSDate(now, { zone: "utc" })
        .plus({ minutes: TTL_MINUTES })
        .toISO(),
    },
  });
}

export async function handleExternalCalendarEditTurn(
  ctx: BotContext,
  text: string,
  timezone: string,
) {
  const owner = requireOwner(ctx);
  const action = await getLatestAgentActionByStatus({
    userId: owner.id,
    actionType: ACTION_TYPE,
    status: "pending",
  });
  if (!action) return false;
  const eventId = typeof action.output?.externalEventId === "string" ? action.output.externalEventId : null;
  const expiresAt =
    typeof action.output?.expiresAt === "string" ? new Date(action.output.expiresAt) : null;
  const event = eventId ? await getExternalCalendarEventById(owner.id, eventId) : null;
  if (!event || !expiresAt || expiresAt <= new Date()) {
    await updateAgentAction({
      userId: owner.id,
      actionId: action.id,
      status: "cancelled",
      output: { ...action.output, cancelledReason: "expired_or_missing" },
    });
    return false;
  }
  if (event.isRecurring) {
    await replyAndRecord(
      ctx,
      "Для повторяющейся серии сейчас доступны удаление всей серии или скрытие в JARVIS. Изменение отдельного повтора пока не поддерживается.",
    );
    return true;
  }

  const mutation = parseItemEditMutation({
    text,
    item: externalEventAsPlannerItem(event),
    timezone,
  });
  if (!mutation.title && !mutation.scheduledForLocal) {
    await replyAndRecord(
      ctx,
      "Напиши новое название и/или время. Например: «Изменить на Общий созвон, время с 19.00 до 20.00».",
    );
    return true;
  }
  const startAt = mutation.scheduledForLocal
    ? DateTime.fromISO(mutation.scheduledForLocal, { zone: event.timezone }).toUTC().toJSDate()
    : event.startAt;
  const oldDuration = event.endAt ? event.endAt.getTime() - event.startAt.getTime() : null;
  const endAt = mutation.endsAtLocal
    ? DateTime.fromISO(mutation.endsAtLocal, { zone: event.timezone }).toUTC().toJSDate()
    : oldDuration && oldDuration > 0
      ? new Date(startAt.getTime() + oldDuration)
      : null;
  const summary = mutation.title ?? event.summary;
  try {
    await updateYandexCalendarObject({
      calendarObjectUrl: event.calendarObjectUrl,
      uid: event.uid,
      etag: event.etag,
      summary,
      description: event.description,
      location: event.location,
      startAt,
      endAt,
    });
    await upsertExternalCalendarEvent({
      userId: owner.id,
      calendarLabel: event.calendarLabel,
      calendarObjectUrl: event.calendarObjectUrl,
      uid: event.uid,
      etag: event.etag,
      summary,
      description: event.description,
      location: event.location,
      startAt,
      endAt,
      timezone: event.timezone,
      isRecurring: false,
      recurrenceId: "",
      metadata: { ...event.metadata, editedFromJarvisAt: new Date().toISOString() },
    });
    await updateAgentAction({
      userId: owner.id,
      actionId: action.id,
      status: "completed",
      output: { ...action.output, updatedExternalEventId: event.id },
    });
    await replyAndRecord(
      ctx,
      `Готово: ${summary} — ${DateTime.fromJSDate(startAt, { zone: "utc" }).setZone(event.timezone).toFormat("dd.LL HH:mm")}${endAt ? `–${DateTime.fromJSDate(endAt, { zone: "utc" }).setZone(event.timezone).toFormat("HH:mm")}` : ""}\nКалендарь: Яндекс · ${event.calendarLabel} · synced`,
    );
    if (ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  } catch (error) {
    const safe = classifyYandexCalendarError(error);
    await updateAgentAction({
      userId: owner.id,
      actionId: action.id,
      status: "failed",
      output: { ...action.output, errorClass: safe.errorClass },
    });
    await replyAndRecord(
      ctx,
      `Не смог безопасно обновить событие в Яндекс.Календаре (${safe.errorClass}). Ничего не изменил.`,
    );
  }
  return true;
}

export async function clearExternalCalendarEditSession(params: {
  userId: string;
  reason?: string;
}) {
  const action = await getLatestAgentActionByStatus({
    userId: params.userId,
    actionType: ACTION_TYPE,
    status: "pending",
  });
  if (!action) return null;
  return updateAgentAction({
    userId: params.userId,
    actionId: action.id,
    status: "cancelled",
    output: { ...action.output, cancelledReason: params.reason ?? "cleared" },
  });
}

function externalEventAsPlannerItem(event: ExternalCalendarEvent): PlannerItem {
  return {
    id: event.id,
    userId: event.userId,
    pendingActionId: null,
    kind: "event",
    status: "active",
    title: event.summary,
    description: event.description,
    location: event.location,
    timezone: event.timezone,
    startAt: event.startAt,
    endAt: event.endAt,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "calendar_external",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "yandex_external",
    metadata: event.metadata,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}
