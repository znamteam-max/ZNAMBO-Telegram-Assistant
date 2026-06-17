import type { PlannerItem } from "@/db/schema";

export type EventReminderExtraPlan =
  | { kind: "scheduled"; scheduledAt: Date; minutesFromNow: number }
  | { kind: "needs_choice"; optionsMinutes: number[]; reason: "event_too_close" }
  | { kind: "unavailable"; reason: "no_event_anchor" | "event_already_started" };

export function isEventLikePlannerItem(
  item?: Pick<PlannerItem, "kind" | "startAt" | "dueAt"> | null,
) {
  return Boolean(item && ["event", "training", "tentative_event"].includes(item.kind));
}

export function eventReminderAnchor(
  item?: Pick<PlannerItem, "startAt" | "dueAt" | "endAt"> | null,
) {
  return item?.startAt ?? item?.dueAt ?? item?.endAt ?? null;
}

export function validEventReminderSnoozeOptions(params: {
  item: Pick<PlannerItem, "startAt" | "dueAt" | "endAt">;
  now: Date;
  optionsMinutes?: number[];
}) {
  const anchor = eventReminderAnchor(params.item);
  if (!anchor) return [];
  const options = params.optionsMinutes ?? [30, 60];
  return options.filter((minutes) => {
    const fireAt = new Date(params.now.getTime() + minutes * 60_000);
    return fireAt.getTime() < anchor.getTime();
  });
}

export function planSmartExtraEventReminder(params: {
  item: Pick<PlannerItem, "startAt" | "dueAt" | "endAt">;
  now: Date;
}): EventReminderExtraPlan {
  const anchor = eventReminderAnchor(params.item);
  if (!anchor) return { kind: "unavailable", reason: "no_event_anchor" };
  const minutesUntil = Math.floor((anchor.getTime() - params.now.getTime()) / 60_000);
  if (minutesUntil <= 0) return { kind: "unavailable", reason: "event_already_started" };
  if (minutesUntil < 10) {
    return {
      kind: "needs_choice",
      optionsMinutes: [5].filter(
        (minutes) => params.now.getTime() + minutes * 60_000 < anchor.getTime(),
      ),
      reason: "event_too_close",
    };
  }

  let minutesFromNow: number;
  if (minutesUntil > 90) {
    minutesFromNow = roundToNearestFive(minutesUntil / 2);
  } else if (minutesUntil >= 30) {
    minutesFromNow = minutesUntil >= 45 ? 20 : 15;
  } else {
    minutesFromNow = minutesUntil >= 20 ? 10 : 5;
  }

  minutesFromNow = Math.max(5, Math.min(minutesFromNow, minutesUntil - 1));
  const scheduledAt = roundDateToFiveMinutes(
    new Date(params.now.getTime() + minutesFromNow * 60_000),
    params.now,
    anchor,
  );
  const adjustedMinutes = Math.max(
    1,
    Math.round((scheduledAt.getTime() - params.now.getTime()) / 60_000),
  );
  if (scheduledAt.getTime() >= anchor.getTime()) {
    return {
      kind: "needs_choice",
      optionsMinutes: [5, 10].filter(
        (minutes) => params.now.getTime() + minutes * 60_000 < anchor.getTime(),
      ),
      reason: "event_too_close",
    };
  }
  return { kind: "scheduled", scheduledAt, minutesFromNow: adjustedMinutes };
}

function roundToNearestFive(value: number) {
  return Math.max(5, Math.round(value / 5) * 5);
}

function roundDateToFiveMinutes(candidate: Date, now: Date, anchor: Date) {
  const roundedMs = Math.round(candidate.getTime() / 300_000) * 300_000;
  let rounded = new Date(roundedMs);
  if (rounded.getTime() <= now.getTime()) rounded = new Date(now.getTime() + 5 * 60_000);
  if (rounded.getTime() >= anchor.getTime()) {
    rounded = new Date(anchor.getTime() - 60_000);
  }
  return rounded;
}
