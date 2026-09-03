import { DateTime } from "luxon";
import type { ActionPlan } from "@/ai/schemas";
import { parseRussianDateTime } from "@/services/russianDateTime";

// AI Local fields are wall-clock values, never pre-converted UTC without an offset.
// Repair only one explicit event clock, using the same parser as direct item edits.
export function normalizeActionPlanEventTime(params: {
  plan: ActionPlan; text: string; timezone: string; now: Date;
}): ActionPlan {
  if (params.plan.intent !== "plan" || params.plan.actions.length !== 1) return params.plan;
  const action = params.plan.actions[0];
  if (!["event", "training", "tentative_event"].includes(action.kind) || !action.startAtLocal) return params.plan;
  const clocks = [...params.text.matchAll(/(?:^|\s)(?:в|на)\s+([01]?\d|2[0-3])(?:[:.]([0-5]\d))?(?=$|[\s,.;!?])/gi)];
  if (clocks.length !== 1) return params.plan;
  // Different named zones and ranges need the existing richer interpretation.
  if (/(?:UTC|GMT|[A-Za-z]+\/[A-Za-z_]+|по\s+\S+\s+времени|с\s+\d.*до\s+\d)/i.test(params.text)) return params.plan;
  if (/(?:напом|уведом)/i.test(params.text.slice(0, clocks[0].index))) return params.plan;
  const intended = parseRussianDateTime({ text: params.text, timezone: params.timezone, now: params.now });
  if (!intended || intended.warnings.includes("time_missing_default_08_00")) return params.plan;
  const oldZone = action.timezone || params.timezone;
  const oldStart = DateTime.fromISO(action.startAtLocal, { zone: oldZone });
  if (!oldStart.isValid) throw new Error("Invalid ActionPlan event start datetime");
  const start = intended.local;
  const shiftMs = start.toMillis() - oldStart.toMillis();
  const local = (value: DateTime) => value.setZone(params.timezone).toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const shiftLocal = (value: string) => {
    const parsed = DateTime.fromISO(value, { zone: oldZone });
    if (!parsed.isValid) throw new Error("Invalid ActionPlan event datetime");
    return local(parsed.plus({ milliseconds: shiftMs }));
  };
  return {
    ...params.plan,
    requiresConfirmation: params.plan.requiresConfirmation || intended.pastConfirmationRequired,
    actions: [{
      ...action,
      timezone: params.timezone,
      startAtLocal: local(start),
      endAtLocal: action.endAtLocal ? shiftLocal(action.endAtLocal) : null,
      requiresConfirmation: action.requiresConfirmation || intended.pastConfirmationRequired,
      reminders: action.reminders.map((reminder) => {
        // Only relative offsets follow the corrected event; absolute reminders don't.
        if (reminder.offsetMinutesBefore == null) return reminder;
        return { ...reminder, scheduledAtLocal: local(start.minus({ minutes: reminder.offsetMinutesBefore })) };
      }),
    }],
  };
}
