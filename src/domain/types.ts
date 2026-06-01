export const itemKinds = [
  "event",
  "task",
  "training",
  "note",
  "preparation_task",
  "tentative_event",
  "recurring_task",
] as const;
export type ItemKind = (typeof itemKinds)[number];

export const reminderTypes = [
  "24h",
  "day_morning",
  "1h",
  "readiness_repeat",
  "followup",
  "task_overdue",
  "training_followup",
  "morning_digest",
  "evening_checkin",
  "custom",
  "15m",
  "30m",
  "event_before",
  "event_start",
  "preparation",
  "after_event",
  "recurring",
  "until_ack",
  "escalation",
] as const;
export type ReminderType = (typeof reminderTypes)[number];

export type MaterializedReminder = {
  type: ReminderType;
  scheduledAt: Date;
  payload: Record<string, unknown>;
  repeatUntilAck?: boolean;
  recurrenceKey?: string | null;
};

export type MaterializedItem = {
  kind: ItemKind;
  title: string;
  description?: string | null;
  location?: string | null;
  timezone: string;
  startAt?: Date | null;
  endAt?: Date | null;
  dueAt?: Date | null;
  priority: number;
  metadata: Record<string, unknown>;
};
