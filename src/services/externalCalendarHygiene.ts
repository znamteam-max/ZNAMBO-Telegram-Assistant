import type { ExternalCalendarEvent } from "@/db/schema";

export type ExternalCalendarVisibilityMode =
  | "jarvis_only"
  | "today_future"
  | "future_30_days";

export type ExternalCalendarVisibilityPreferences = {
  mode: ExternalCalendarVisibilityMode;
  showPast: boolean;
  showServiceEvents: boolean;
};

export const DEFAULT_EXTERNAL_CALENDAR_VISIBILITY: ExternalCalendarVisibilityPreferences = {
  mode: "today_future",
  showPast: false,
  showServiceEvents: false,
};

const SERVICE_SUMMARY_PATTERNS = [
  /^ZNAMBO CalDAV write verification/i,
  /^V2\.6\.0 production delivery check/i,
  /Production repair reminder smoke/i,
  /CalDAV write verification/i,
];

const SERVICE_UID_PATTERNS = [/znambo-test/i, /calendar-test/i, /write-verification/i];

export function isExternalCalendarServiceEvent(
  event: Pick<ExternalCalendarEvent, "summary" | "uid" | "metadata">,
) {
  return (
    SERVICE_SUMMARY_PATTERNS.some((pattern) => pattern.test(event.summary)) ||
    SERVICE_UID_PATTERNS.some((pattern) => pattern.test(event.uid)) ||
    event.metadata?.isServiceEvent === true ||
    event.metadata?.xZnamboTest === true
  );
}

export function isPastExternalCalendarEvent(
  event: Pick<ExternalCalendarEvent, "startAt" | "endAt">,
  now: Date,
) {
  const end = event.endAt ?? new Date(event.startAt.getTime() + 60 * 60 * 1000);
  return end <= now;
}

export function classifyExternalCalendarEventHygiene(
  event: Pick<ExternalCalendarEvent, "summary" | "uid" | "metadata" | "startAt" | "endAt">,
  now: Date,
) {
  const isServiceEvent = isExternalCalendarServiceEvent(event);
  const isPastEvent = isPastExternalCalendarEvent(event, now);
  return {
    isServiceEvent,
    isPastEvent,
    hiddenReason: isServiceEvent
      ? "service_test_event"
      : isPastEvent
        ? "past_external_event"
        : null,
  };
}

export function parseExternalCalendarVisibilityPreferences(
  metadata?: Record<string, unknown> | null,
): ExternalCalendarVisibilityPreferences {
  const raw = metadata?.externalCalendarVisibility;
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const mode = ["jarvis_only", "today_future", "future_30_days"].includes(String(value.mode))
    ? (String(value.mode) as ExternalCalendarVisibilityMode)
    : DEFAULT_EXTERNAL_CALENDAR_VISIBILITY.mode;
  return {
    mode,
    showPast: value.showPast === true,
    showServiceEvents: value.showServiceEvents === true,
  };
}

export function shouldShowExternalCalendarEvent(params: {
  event: Pick<ExternalCalendarEvent, "summary" | "uid" | "metadata" | "startAt" | "endAt">;
  preferences: ExternalCalendarVisibilityPreferences;
  now: Date;
}) {
  if (params.preferences.mode === "jarvis_only") return false;
  const hygiene = classifyExternalCalendarEventHygiene(params.event, params.now);
  if (hygiene.isServiceEvent && !params.preferences.showServiceEvents) return false;
  if (hygiene.isPastEvent && !params.preferences.showPast) return false;
  return true;
}
