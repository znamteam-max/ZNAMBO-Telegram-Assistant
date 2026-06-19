import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import {
  buildOrthodontistReminderTemplate,
  ORTHODONTIST_TEMPLATE_VERSION,
} from "@/domain/orthodontistReminderTemplate";
import {
  parseRussianWeekdayAppointment,
  stripRussianWeekdaySchedulePhrase,
} from "@/domain/russianWeekday";
import { getTelegramDeliveryPolicy, withTelegramDeliveryPolicy } from "@/telegram/deliveryPolicy";

describe("V2.26 general reminder fix", () => {
  it("keeps alerts loud and automatic dashboards/status output silent", () => {
    expect(getTelegramDeliveryPolicy("reminder_alert").disableNotification).toBe(false);
    expect(getTelegramDeliveryPolicy("renag_alert").disableNotification).toBe(false);
    expect(getTelegramDeliveryPolicy("event_alert").disableNotification).toBe(false);
    expect(getTelegramDeliveryPolicy("dashboard_refresh").disableNotification).toBe(true);
    expect(getTelegramDeliveryPolicy("status_ack").disableNotification).toBe(true);
    expect(withTelegramDeliveryPolicy("cleanup_status")).toEqual({
      disable_notification: true,
    });
  });

  it("resolves a Friday weekday request to next Monday startAt, never Friday dueAt", () => {
    const text = "В понедельник в 12:00 отвезти машину на техобслуживание";
    const now = new Date("2026-06-19T09:00:00.000Z");
    expect(
      parseRussianWeekdayAppointment({ text, timezone: "Europe/Moscow", now })?.localDateTime,
    ).toBe("2026-06-22T12:00:00");
    expect(stripRussianWeekdaySchedulePhrase(text)).toBe("Отвезти машину на техобслуживание");

    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text,
      timezone: "Europe/Moscow",
      now,
      activeContext: "none",
    });
    expect(execution.actionPlan?.actions).toHaveLength(1);
    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({
        kind: "task",
        title: "Отвезти машину на техобслуживание",
        startAtLocal: "2026-06-22T12:00:00",
        dueAtLocal: null,
      }),
    );
  });

  it("keeps explicit deadline wording on dueAt semantics", () => {
    const text = "Сдать отчет до понедельника в 12:00";
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text,
      timezone: "Europe/Moscow",
      now: new Date("2026-06-19T09:00:00.000Z"),
      activeContext: "none",
    });
    expect(execution.actionPlan?.actions[0]?.dueAtLocal).toBe("2026-06-22T12:00:00");
    expect(execution.actionPlan?.actions[0]?.startAtLocal).toBeNull();
  });

  it("builds the exact five-part orthodontist template for both known visits", () => {
    const starts = [
      DateTime.fromISO("2026-07-01T19:00:00", { zone: "Europe/Moscow" }),
      DateTime.fromISO("2026-07-02T11:45:00", { zone: "Europe/Moscow" }),
    ];
    const templates = starts.map((eventStart) => buildOrthodontistReminderTemplate({ eventStart }));
    const expectedRoles = ["week", "three_days", "visit_morning", "two_hours", "thirty_minutes"];
    for (const template of templates) {
      expect(template.map((entry) => entry.templateRole)).toEqual(expectedRoles);
      expect(template.map((entry) => entry.relativeLabel)).toEqual([
        "за неделю",
        "за 3 дня",
        "утром в день визита",
        "за 2 часа",
        "за 30 минут",
      ]);
    }
    expect(templates[0][2].fireAt.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-07-01 09:00");
    expect(templates[0][3].fireAt.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-07-01 17:00");
    expect(templates[0][4].fireAt.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-07-01 18:30");
    expect(templates[1][2].fireAt.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-07-02 09:00");
    expect(templates[1][3].fireAt.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-07-02 09:45");
    expect(templates[1][4].fireAt.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-07-02 11:15");
    expect(ORTHODONTIST_TEMPLATE_VERSION).toBe("v2260");
  });
});

function emptyExecution() {
  return agentExecutionSchema.parse({
    intent: "clarify",
    reply: null,
    actionPlan: null,
    viewScope: null,
    resetMode: null,
    itemUpdates: [],
    reminderPolicies: [],
    memoryFacts: [],
    clarificationQuestions: [],
  });
}
