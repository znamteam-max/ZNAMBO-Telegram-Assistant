import { DateTime } from "luxon";

import type { MaterializedItem, MaterializedReminder, ReminderType } from "./types";

const DEFAULT_PRESETS: Record<string, ReminderType[]> = {
  event: ["24h", "day_morning", "1h", "followup"],
  training: ["day_morning", "1h", "training_followup"],
  task: ["custom", "task_overdue"],
  preparation_task: ["custom", "task_overdue"],
  note: [],
};

export function buildPresetReminders(
  item: MaterializedItem,
  now: Date,
  requestedPresets?: ReminderType[],
): MaterializedReminder[] {
  const presets = requestedPresets?.length ? requestedPresets : (DEFAULT_PRESETS[item.kind] ?? []);
  const candidates = presets
    .map((type) => buildReminder(type, item))
    .filter((reminder): reminder is MaterializedReminder => Boolean(reminder))
    .filter((reminder) => reminder.scheduledAt.getTime() > now.getTime());

  const unique = new Map<string, MaterializedReminder>();
  for (const candidate of candidates) {
    unique.set(`${candidate.type}:${candidate.scheduledAt.toISOString()}`, candidate);
  }
  return [...unique.values()].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

function buildReminder(type: ReminderType, item: MaterializedItem): MaterializedReminder | null {
  const base = item.startAt ?? item.dueAt;
  const timezone = item.timezone;
  if (!base && !["morning_digest", "evening_checkin"].includes(type)) return null;

  const baseLocal = base ? DateTime.fromJSDate(base, { zone: "utc" }).setZone(timezone) : null;
  let scheduled: DateTime | null = null;

  switch (type) {
    case "24h":
      scheduled = baseLocal?.minus({ hours: 24 }) ?? null;
      break;
    case "day_morning":
      scheduled = baseLocal?.startOf("day").plus({ hours: 9 }) ?? null;
      break;
    case "1h":
      scheduled = baseLocal?.minus({ hours: 1 }) ?? null;
      break;
    case "custom":
      scheduled = baseLocal ?? null;
      break;
    case "task_overdue":
      scheduled = baseLocal?.plus({ minutes: 15 }) ?? null;
      break;
    case "followup":
      scheduled = item.endAt
        ? DateTime.fromJSDate(item.endAt, { zone: "utc" }).setZone(timezone).plus({ minutes: 30 })
        : (baseLocal?.plus({ hours: 1, minutes: 30 }) ?? null);
      break;
    case "training_followup":
      scheduled = item.endAt
        ? DateTime.fromJSDate(item.endAt, { zone: "utc" }).setZone(timezone).plus({ minutes: 15 })
        : (baseLocal?.plus({ hours: 2 }) ?? null);
      break;
    case "readiness_repeat":
      scheduled = baseLocal?.minus({ minutes: 45 }) ?? null;
      break;
    case "morning_digest":
    case "evening_checkin":
      scheduled = null;
      break;
  }

  if (!scheduled?.isValid) return null;
  return {
    type,
    scheduledAt: scheduled.toUTC().toJSDate(),
    payload: { title: item.title, kind: item.kind },
  };
}
