import {
  getCalendarImportState,
  hideExternalCalendarEventWithReason,
  listExternalCalendarEventsForCleanup,
  updateCalendarImportPreferences,
  updateExternalCalendarEventMetadata,
  unhideExternalCalendarEventsByReason,
} from "@/db/queries/externalCalendarEvents";
import {
  classifyExternalCalendarEventHygiene,
  DEFAULT_EXTERNAL_CALENDAR_VISIBILITY,
  parseExternalCalendarVisibilityPreferences,
  type ExternalCalendarVisibilityPreferences,
} from "@/services/externalCalendarHygiene";

export async function previewExternalCalendarCleanup(params: {
  userId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const events = await listExternalCalendarEventsForCleanup(params.userId);
  const serviceEvents = events.filter(
    (event) => !event.hiddenAt && classifyExternalCalendarEventHygiene(event, now).isServiceEvent,
  );
  const pastEvents = events.filter((event) => {
    const hygiene = classifyExternalCalendarEventHygiene(event, now);
    return (
      !hygiene.isServiceEvent &&
      hygiene.isPastEvent &&
      event.metadata?.hiddenFromDefaultPlan !== true
    );
  });
  const possibleDuplicates = events.filter(
    (event) => !event.hiddenAt && event.metadata?.possibleDuplicate === true,
  );
  return {
    serviceEvents,
    pastEvents,
    possibleDuplicates,
    counts: {
      serviceEvents: serviceEvents.length,
      pastEvents: pastEvents.length,
      possibleDuplicates: possibleDuplicates.length,
    },
  };
}

export async function applyExternalCalendarCleanup(params: {
  userId: string;
  now?: Date;
}) {
  const preview = await previewExternalCalendarCleanup(params);
  for (const event of preview.serviceEvents) {
    await hideExternalCalendarEventWithReason({
      userId: params.userId,
      id: event.id,
      reason: "service_test_event",
    });
  }
  for (const event of preview.pastEvents) {
    await updateExternalCalendarEventMetadata({
      userId: params.userId,
      id: event.id,
      metadata: {
        hiddenFromDefaultPlan: true,
        hiddenReason: "past_external_event",
      },
    });
  }
  return preview;
}

export async function getExternalCalendarVisibilityPreferences(userId: string) {
  const state = await getCalendarImportState(userId);
  return parseExternalCalendarVisibilityPreferences(state?.metadata);
}

export async function setExternalCalendarVisibilityPreferences(params: {
  userId: string;
  preferences: Partial<ExternalCalendarVisibilityPreferences>;
}) {
  const current = await getExternalCalendarVisibilityPreferences(params.userId);
  const next = { ...DEFAULT_EXTERNAL_CALENDAR_VISIBILITY, ...current, ...params.preferences };
  await updateCalendarImportPreferences({ userId: params.userId, preferences: next });
  if (params.preferences.showServiceEvents === true) {
    await unhideExternalCalendarEventsByReason({
      userId: params.userId,
      reason: "service_test_event",
    });
  } else if (params.preferences.showServiceEvents === false) {
    await applyExternalCalendarCleanup({ userId: params.userId });
  }
  return next;
}
