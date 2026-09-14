import { describe, expect, it } from "vitest";

import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { parseStandaloneIntervalWindowReminderIntent } from "@/domain/intervalWindowReminderIntent";
import { computeNextPolicySlotAfterDelivery } from "@/domain/reminderPolicySchedule";
import { parseWeeklyTaskReminderIntent } from "@/domain/weeklyTaskReminderIntent";
import {
  resolveRecurringOccurrenceDeadline,
} from "@/services/recurringOccurrenceCompletion";
import { resolveWeeklyTaskCycle } from "@/services/weeklyTaskReminderCreation";

const exactPrompt =
  "Каждую пятницу создавай задачу «Подготовить темы для эфира Больше Live». Дедлайн — в эту пятницу в 13:00. Начинай напоминать в 08:00 и напоминай каждый час до 13:00, пока я не отмечу задачу выполненной.";

describe("V3.0.8 weekly task reminder semantics", () => {
  it("parses the exact Sep 14 prompt into title, deadline and hourly Friday window", () => {
    const intent = parseWeeklyTaskReminderIntent({
      text: exactPrompt,
      timezone: "Europe/Moscow",
    });

    expect(intent).toEqual({
      intent: "weekly_task_reminder",
      title: "Подготовить темы для эфира Больше Live",
      weekday: "FR",
      recurrenceRule: "weekly:FR@08:00",
      reminderStartLocal: "08:00",
      reminderEndLocal: "13:00",
      deadlineLocal: "13:00",
      intervalMinutes: 60,
      requireAck: true,
      timezone: "Europe/Moscow",
      source: "weekly_task_reminder_intent",
    });
  });

  it("escapes the general AI recurring parser through the deterministic interval route", () => {
    const intent = parseStandaloneIntervalWindowReminderIntent({
      text: exactPrompt,
      timezone: "Europe/Moscow",
      now: new Date("2026-09-14T06:17:00.000Z"),
    });

    expect(intent).not.toBeNull();
    expect(intent && "weeklyTask" in intent).toBe(true);
    if (!intent || !("weeklyTask" in intent)) throw new Error("Expected weekly task intent");
    expect(intent.title).toBe("Подготовить темы для эфира Больше Live");
    expect(intent.weeklyTask.reminderStartLocal).toBe("08:00");
    expect(intent.weeklyTask.reminderEndLocal).toBe("13:00");
  });

  it("resolves the next Friday reminder and deadline in Europe/Moscow", () => {
    const intent = parseWeeklyTaskReminderIntent({
      text: exactPrompt,
      timezone: "Europe/Moscow",
    });
    if (!intent) throw new Error("Expected intent");
    const timing = resolveWeeklyTaskCycle({
      intent,
      now: new Date("2026-09-14T06:17:00.000Z"),
    });

    expect(timing.cycleStart.toISOString()).toBe("2026-09-18T05:00:00.000Z");
    expect(timing.nextFireAt.toISOString()).toBe("2026-09-18T05:00:00.000Z");
    expect(timing.windowEnd.toISOString()).toBe("2026-09-18T10:00:00.000Z");
    expect(timing.deadline.toISOString()).toBe("2026-09-18T10:00:00.000Z");
  });

  it("keeps hourly delivery inside Friday 08:00-13:00 and then advances a week", () => {
    const policy = {
      id: "policy",
      userId: "user",
      itemId: "item",
      title: "Подготовить темы для эфира Больше Live",
      category: "content",
      policyType: "recurring",
      status: "active",
      timezone: "Europe/Moscow",
      startsAt: new Date("2026-09-18T05:00:00.000Z"),
      endsAt: null,
      nextFireAt: new Date("2026-09-18T05:00:00.000Z"),
      recurrenceRule: "weekly:FR@08:00",
      intervalMinutes: 60,
      requireAck: true,
      maxOccurrences: null,
      windowEndInclusive: true,
      catchUpMode: "one_immediate_then_resume",
      onWindowEnd: "expire_silently",
      quietHours: null,
      snoozedUntil: null,
      snoozeScope: null,
      metadata: {
        activeWindowStart: "08:00",
        activeWindowEnd: "13:00",
        recurringParentPersistent: true,
        stopOnItemComplete: false,
        recurringOccurrenceDeadlineTime: "13:00",
      },
      createdAt: new Date("2026-09-14T06:17:00.000Z"),
      updatedAt: new Date("2026-09-14T06:17:00.000Z"),
    } as ReminderPolicy;

    expect(
      computeNextPolicySlotAfterDelivery({
        policy,
        scheduledFor: new Date("2026-09-18T05:00:00.000Z"),
        now: new Date("2026-09-18T05:01:00.000Z"),
      })?.toISOString(),
    ).toBe("2026-09-18T06:00:00.000Z");

    expect(
      computeNextPolicySlotAfterDelivery({
        policy,
        scheduledFor: new Date("2026-09-18T10:00:00.000Z"),
        now: new Date("2026-09-18T10:01:00.000Z"),
      })?.toISOString(),
    ).toBe("2026-09-25T05:00:00.000Z");
  });

  it("advances the task deadline with the next recurring occurrence", () => {
    const item = {
      metadata: { recurringOccurrenceDeadlineTime: "13:00" },
    } as Pick<PlannerItem, "metadata">;
    expect(
      resolveRecurringOccurrenceDeadline({
        item,
        nextFireAt: new Date("2026-09-25T05:00:00.000Z"),
        timezone: "Europe/Moscow",
      })?.toISOString(),
    ).toBe("2026-09-25T10:00:00.000Z");
  });
});
