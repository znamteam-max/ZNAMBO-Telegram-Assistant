import { DateTime } from "luxon";

import { createReminderIfMissing } from "@/db/queries/reminders";
import { listUsers } from "@/db/queries/users";

export async function scheduleDailyDigestsForDate(localDateIso?: string) {
  const users = await listUsers();
  let created = 0;
  for (const user of users) {
    const day = localDateIso
      ? DateTime.fromISO(localDateIso, { zone: user.timezone })
      : DateTime.utc().setZone(user.timezone).plus({ days: 1 }).startOf("day");
    const dateKey = day.toISODate();
    const morning = await createReminderIfMissing({
      userId: user.id,
      type: "morning_digest",
      idempotencyKey: `${user.id}:morning_digest:${dateKey}`,
      scheduledAt: day.plus({ hours: 8 }).toUTC().toJSDate(),
      payload: { date: dateKey },
    });
    const evening = await createReminderIfMissing({
      userId: user.id,
      type: "evening_checkin",
      idempotencyKey: `${user.id}:evening_checkin:${dateKey}`,
      scheduledAt: day.plus({ hours: 21 }).toUTC().toJSDate(),
      payload: { date: dateKey },
    });
    if (morning) created += 1;
    if (evening) created += 1;
  }
  return { created };
}
