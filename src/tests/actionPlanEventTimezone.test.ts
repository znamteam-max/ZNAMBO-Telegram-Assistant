import { describe, expect, it } from "vitest";
import { normalizeActionPlanEventTime } from "@/ai/actionPlanEventTime";
import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { actionPlanSchema } from "@/ai/schemas";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import { materializeAction } from "@/services/actionPlanCommit";
import { parseItemEditMutation } from "@/services/itemEditMutations";
import { formatRuWeekdayDateTime, localIsoToUtcDate } from "@/domain/dateTime";
import { buildIcs, parseIcsEvents } from "@/integrations/yandexCalendar";
import type { PlannerItem } from "@/db/schema";

const now = new Date("2026-09-03T06:00:00Z");
const text = "Созвон по Взял Мчч в 18.00";
function plan(timezone: string, start = "2026-09-03T15:00:00", end = "2026-09-03T16:00:00") {
  return actionPlanSchema.parse({ actions: [{
    actionType: "event", kind: "event", title: "Тестовый созвон", timezone,
    startAtLocal: start, endAtLocal: end,
    reminders: [{ type: "event_before", offsetMinutesBefore: 60, scheduledAtLocal: "2026-09-03T14:00:00" }],
  }] });
}

describe("ActionPlan creation local-time boundary", () => {
  it.each([
    ["Europe/Moscow", "2026-09-03T15:00:00.000Z"],
    ["America/New_York", "2026-09-03T22:00:00.000Z"],
    ["Asia/Kolkata", "2026-09-03T12:30:00.000Z"],
  ])("creation and direct edit round-trip to 18:00 in %s", (timezone, expected) => {
    const execution = normalizeAgentExecutionProposal({
      execution: agentExecutionSchema.parse({
        intent: "create_plan", reply: null, actionPlan: plan(timezone), viewScope: null,
        resetMode: null, itemUpdates: [], reminderPolicies: [], memoryFacts: [], clarificationQuestions: [],
      }), text, timezone, now, activeContext: "none",
    });
    const normalized = execution.actionPlan!;
    // This is the ActionPlan JSON actually sent toward storage, not just a formatter.
    expect(normalized.actions[0].startAtLocal).toBe("2026-09-03T18:00:00");
    expect(normalized.actions[0].endAtLocal).toBe("2026-09-03T19:00:00");
    const created = materializeAction({ action: normalized.actions[0], timezone, now, actionPlanId: "test-plan", sequence: 0 });
    const item = { ...created.item, id: "00000000-0000-4000-8000-000000000001", status: "active" } as PlannerItem;
    const edit = parseItemEditMutation({ text: "Сегодня в 18:00", item, timezone, now });
    const editedStart = localIsoToUtcDate(edit.scheduledForLocal!, timezone);
    expect(created.item.startAt?.toISOString()).toBe(expected);
    expect(editedStart).toEqual(created.item.startAt);
    expect(formatRuWeekdayDateTime(created.item.startAt, timezone, { timeOnly: true })).toBe("18:00");
    expect(formatRuWeekdayDateTime(editedStart, timezone, { timeOnly: true })).toBe("18:00");
    const ics = buildIcs(item, "https://calendar.test/test.ics");
    expect(ics).toContain(`DTSTART:${expected.replace(/[-:]/g, "").replace(".000", "")}`);
    const event = parseIcsEvents(ics, timezone)[0];
    expect(event.startAt.toISOString()).toBe(expected);
    expect(formatRuWeekdayDateTime(event.startAt, timezone, { timeOnly: true })).toBe("18:00");
    expect(created.reminders[0].scheduledAt.getTime()).toBe(editedStart.getTime() - 60 * 60_000);
    expect(normalizeActionPlanEventTime({ plan: normalized, text, timezone, now })).toEqual(normalized);
  });

  it.each([
    ["2026-09-03T18:00:00", "2026-09-03T19:00:00"],
    ["2026-09-03T15:00:00Z", "2026-09-03T16:00:00Z"],
    ["2026-09-03T18:00:00+03:00", "2026-09-03T19:00:00+03:00"],
  ])("does not double-convert an already correct start %s", (start, end) => {
    const normalized = normalizeActionPlanEventTime({ plan: plan("Europe/Moscow", start, end), text, timezone: "Europe/Moscow", now });
    expect(normalized.actions[0].startAtLocal).toBe("2026-09-03T18:00:00");
    expect(normalized.actions[0].endAtLocal).toBe("2026-09-03T19:00:00");
  });

  it.each(["Созвон в 18:00 UTC", "Созвон в 18:00 и тренировка в 20:00", "Напомни о созвоне в 18:00"])(
    "leaves complex or reminder-only clocks to existing interpretation: %s", (text) => {
      const input = plan("Europe/Moscow");
      expect(normalizeActionPlanEventTime({ plan: input, text, timezone: "Europe/Moscow", now })).toBe(input);
    },
  );
  it("requires confirmation rather than silently moving explicit today into tomorrow", () => {
    const normalized = normalizeActionPlanEventTime({ plan: plan("Europe/Moscow"), text: "Созвон сегодня в 18:00", timezone: "Europe/Moscow", now: new Date("2026-09-03T18:00:00Z") });
    expect(normalized.requiresConfirmation).toBe(true);
    expect(normalized.actions[0].startAtLocal).toBe("2026-09-03T18:00:00");
  });
});
