import { listCalendarSyncStatesForUser } from "@/db/queries/googleCalendar";
import { retryCalendarItems } from "@/services/calendarSyncRetry";

const ORTHODONTIST_PATTERN = /отвести\s+роба\s+к\s+ортодонту/i;

export async function previewV253CalendarRepair(userId: string) {
  const states = await listCalendarSyncStatesForUser(userId, 200);
  const candidates = states.filter(
    ({ item, sync }) =>
      ["error", "failed", "pending_retry"].includes(sync.status) &&
      (sync.lastError === "timeout" || ORTHODONTIST_PATTERN.test(item.title)),
  );
  return {
    candidateCount: candidates.length,
    orthodontistDetected: candidates.some(({ item }) => ORTHODONTIST_PATTERN.test(item.title)),
    items: candidates.map(({ item, sync }) => ({
      id: item.id,
      title: item.title,
      status: sync.status,
      errorClass: sync.lastError,
      externalIdPresent: Boolean(sync.externalId),
    })),
  };
}

export async function applyV253CalendarRepair(userId: string) {
  const states = await listCalendarSyncStatesForUser(userId, 200);
  const candidates = states.filter(
    ({ item, sync }) =>
      ["error", "failed", "pending_retry"].includes(sync.status) &&
      (sync.lastError === "timeout" || ORTHODONTIST_PATTERN.test(item.title)),
  );
  const preview = await previewV253CalendarRepair(userId);
  const retry = await retryCalendarItems(candidates.map(({ item }) => item));
  return { preview, retry };
}
