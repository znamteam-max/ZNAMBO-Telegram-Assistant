import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";

import { getDb } from "@/db/client";
import { reminders } from "@/db/schema";

export type ReminderSlotChoice = {
  scheduledAt: Date;
  shifted: boolean;
  shiftMinutes: number;
  blockedReason?: "latest_at_exceeded" | "max_attempts_exceeded";
};

export function chooseSpacedReminderSlot(params: {
  desiredAt: Date;
  occupiedSlots: Date[];
  minSpacingMinutes?: number;
  latestAt?: Date | null;
  maxAttempts?: number;
}): ReminderSlotChoice {
  const minSpacingMinutes = params.minSpacingMinutes ?? 5;
  const maxAttempts = params.maxAttempts ?? 24;
  const spacingMs = minSpacingMinutes * 60_000;
  const occupied = [...params.occupiedSlots]
    .filter((slot) => !Number.isNaN(slot.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
  const desiredMs = params.desiredAt.getTime();
  let candidateMs = desiredMs;

  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    if (params.latestAt && candidateMs > params.latestAt.getTime()) {
      return {
        scheduledAt: params.desiredAt,
        shifted: false,
        shiftMinutes: 0,
        blockedReason: "latest_at_exceeded",
      };
    }
    const collision = occupied.find((slot) => Math.abs(slot.getTime() - candidateMs) < spacingMs);
    if (!collision) {
      return {
        scheduledAt: new Date(candidateMs),
        shifted: candidateMs !== desiredMs,
        shiftMinutes: Math.round((candidateMs - desiredMs) / 60_000),
      };
    }
    candidateMs = collision.getTime() + spacingMs;
  }

  return {
    scheduledAt: params.desiredAt,
    shifted: false,
    shiftMinutes: 0,
    blockedReason: "max_attempts_exceeded",
  };
}

export async function findNextAvailableReminderSlot(params: {
  ownerId: string;
  desiredAt: Date;
  minSpacingMinutes?: number;
  latestAt?: Date | null;
  excludeReminderIds?: string[];
  maxAttempts?: number;
}): Promise<ReminderSlotChoice> {
  const minSpacingMinutes = params.minSpacingMinutes ?? 5;
  const maxAttempts = params.maxAttempts ?? 24;
  const spacingMs = minSpacingMinutes * 60_000;
  const from = new Date(params.desiredAt.getTime() - spacingMs + 1);
  const to = new Date(params.desiredAt.getTime() + spacingMs * (maxAttempts + 1));
  const rows = await getDb()
    .select({ id: reminders.id, scheduledAt: reminders.scheduledAt })
    .from(reminders)
    .where(
      and(
        eq(reminders.userId, params.ownerId),
        inArray(reminders.status, ["pending", "claimed"]),
        gte(reminders.scheduledAt, from),
        lt(reminders.scheduledAt, to),
      ),
    )
    .orderBy(asc(reminders.scheduledAt));
  const excluded = new Set(params.excludeReminderIds ?? []);
  return chooseSpacedReminderSlot({
    desiredAt: params.desiredAt,
    occupiedSlots: rows
      .filter((row) => !excluded.has(row.id))
      .map((row) => row.scheduledAt),
    minSpacingMinutes,
    latestAt: params.latestAt,
    maxAttempts,
  });
}
