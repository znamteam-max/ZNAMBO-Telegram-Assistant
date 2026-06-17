import { clearExternalCalendarEditSession } from "@/bot/externalCalendarEditFlow";
import { clearActiveItemEditSession } from "@/services/itemEditSessions";
import { clearActiveMultiReminderSetupSession } from "@/services/multiReminderSetupSessions";
import { clearActiveRecurringPolicyDraftSession } from "@/services/recurringPolicyDraftSessions";
import { clearActiveReminderPolicyEditSession } from "@/services/reminderPolicyEditSessions";
import { isStandaloneIntervalWindowReminderText } from "@/domain/intervalWindowReminderIntent";

export type ClearedInteractionSession =
  | "item_edit_session"
  | "multi_reminder_setup_session"
  | "reminder_policy_edit_session"
  | "recurring_policy_draft"
  | "external_calendar_edit_session";

export type ClearedInteractionSessionDetails = {
  type: ClearedInteractionSession;
  actionId: string;
  itemId: string | null;
};

export function isSessionCancelText(text: string) {
  const normalized = normalizeSessionText(text);
  return /^(?:\/cancel|cancel|отмена|отмени|отменить|стоп|закрыть|выйти|не надо|не нужно)$/.test(
    normalized,
  );
}

export function isGlobalCreationIntent(text: string) {
  const normalized = normalizeSessionText(text);
  if (!normalized) return false;
  if (
    isStandaloneIntervalWindowReminderText({
      text,
      timezone: "Europe/Moscow",
      now: new Date(),
    })
  ) {
    return true;
  }

  const hasReminderVerb =
    /(?:напомни|напомнить|напоминай|напоминать|добавь напоминание|создай напоминание)/.test(
      normalized,
    );
  const hasCreationVerb = /(?:создай задачу|добавь задачу|добавь дело|создай дело)/.test(
    normalized,
  );
  const hasRecurringSignal =
    /(?:кажд|ежедневно|еженедельно|ежемесячно|по понедельникам|по вторникам|по средам|по четвергам|по пятницам|по субботам|по воскресеньям)/.test(
      normalized,
    );
  const hasMultipleReminderRequest =
    /(?:нужно|надо|создай|добавь|поставь)\s+(?:одно|два|три|четыре|пять|\d+)\s+напоминан/.test(
      normalized,
    );
  const startsWithRecurringReminder =
    /^(?:и\s+)?(?:кажд|ежедневно|еженедельно|ежемесячно).*напом/.test(normalized);

  return (
    hasCreationVerb ||
    hasMultipleReminderRequest ||
    startsWithRecurringReminder ||
    (hasReminderVerb && hasRecurringSignal)
  );
}

export async function clearActiveInteractionSessions(params: {
  userId: string;
  reason: string;
  preserve?: ClearedInteractionSession[];
}) {
  const detailed = await clearActiveInteractionSessionsWithDetails(params);
  return detailed.map((entry) => entry.type);
}

export async function clearActiveInteractionSessionsWithDetails(params: {
  userId: string;
  reason: string;
  preserve?: ClearedInteractionSession[];
}) {
  const cleared: ClearedInteractionSessionDetails[] = [];
  const preserve = new Set(params.preserve ?? []);
  const results = await Promise.allSettled([
    preserve.has("item_edit_session")
      ? Promise.resolve(null)
      : clearActiveItemEditSession({ userId: params.userId, reason: params.reason }),
    preserve.has("multi_reminder_setup_session")
      ? Promise.resolve(null)
      : clearActiveMultiReminderSetupSession({ userId: params.userId, reason: params.reason }),
    preserve.has("reminder_policy_edit_session")
      ? Promise.resolve(null)
      : clearActiveReminderPolicyEditSession({ userId: params.userId, reason: params.reason }),
    preserve.has("recurring_policy_draft")
      ? Promise.resolve(null)
      : clearActiveRecurringPolicyDraftSession({ userId: params.userId, reason: params.reason }),
    preserve.has("external_calendar_edit_session")
      ? Promise.resolve(null)
      : clearExternalCalendarEditSession({ userId: params.userId, reason: params.reason }),
  ]);
  if (results[0].status === "fulfilled" && results[0].value) {
    cleared.push(details("item_edit_session", results[0].value));
  }
  if (results[1].status === "fulfilled" && results[1].value) {
    cleared.push(details("multi_reminder_setup_session", results[1].value));
  }
  if (results[2].status === "fulfilled" && results[2].value) {
    cleared.push(details("reminder_policy_edit_session", results[2].value));
  }
  if (results[3].status === "fulfilled" && results[3].value) {
    cleared.push(details("recurring_policy_draft", results[3].value));
  }
  if (results[4].status === "fulfilled" && results[4].value) {
    cleared.push(details("external_calendar_edit_session", results[4].value));
  }
  return cleared;
}

function details(
  type: ClearedInteractionSession,
  action: { id: string; input?: Record<string, unknown>; output?: Record<string, unknown> },
): ClearedInteractionSessionDetails {
  return {
    type,
    actionId: action.id,
    itemId: extractSessionItemId(action.input, action.output),
  };
}

function extractSessionItemId(
  input?: Record<string, unknown>,
  output?: Record<string, unknown>,
) {
  for (const key of ["itemId", "activeEditItemId", "externalEventId"]) {
    const value = output?.[key] ?? input?.[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function normalizeSessionText(text: string) {
  return text
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
