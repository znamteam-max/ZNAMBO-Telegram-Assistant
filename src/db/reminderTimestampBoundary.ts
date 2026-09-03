import { DateTime } from "luxon";
import type { Reminder } from "@/db/schema";

type DateField = "scheduledAt" | "claimedAt" | "sentAt" | "ackedAt" | "createdAt" | "updatedAt";
export type RawClaimedReminder = Omit<Reminder, DateField> & Record<DateField, unknown>;

export class ReminderTimestampError extends Error {
  readonly code = "invalid_reminder_timestamp";
  constructor(readonly field: DateField | "lockedUntil") {
    // Never include the raw value: diagnostics must not expose payloads/secrets.
    super(`invalid_reminder_timestamp:${field}`);
    this.name = "ReminderTimestampError";
  }
}

export function reminderTimestamp(value: unknown, field: DateField | "lockedUntil"): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string") {
    // Raw PostgreSQL timestamptz and ISO JSON instants both require an offset.
    // Do not infer the host timezone for a bare local clock or accept JS rollover.
    const iso = value.replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(iso)) {
      const parsed = DateTime.fromISO(iso, { setZone: true });
      if (parsed.isValid) return parsed.toJSDate();
    }
  }
  throw new ReminderTimestampError(field);
}

export function normalizeClaimedReminder(row: RawClaimedReminder): Reminder {
  const nullable = (value: unknown, field: DateField) =>
    value == null ? null : reminderTimestamp(value, field);
  return {
    ...row,
    scheduledAt: reminderTimestamp(row.scheduledAt, "scheduledAt"),
    claimedAt: nullable(row.claimedAt, "claimedAt"),
    sentAt: nullable(row.sentAt, "sentAt"),
    ackedAt: nullable(row.ackedAt, "ackedAt"),
    createdAt: reminderTimestamp(row.createdAt, "createdAt"),
    updatedAt: reminderTimestamp(row.updatedAt, "updatedAt"),
  };
}
