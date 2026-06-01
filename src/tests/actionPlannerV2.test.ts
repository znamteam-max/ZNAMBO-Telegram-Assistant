import { describe, expect, it } from "vitest";

import { heuristicBuildActionPlan } from "@/ai/heuristicActionPlanner";
import { validateActionPlan } from "@/ai/plan-validator";

const timezone = "Europe/Moscow";

function plan(text: string, nowIso: string) {
  const now = new Date(nowIso);
  return validateActionPlan({
    plan: heuristicBuildActionPlan({ text, timezone, now }),
    text,
    timezone,
    now,
  });
}

describe("Smart planner V2 acceptance cases", () => {
  it("extracts the exact Zoom multi-action scenario without collapsing it to one event", () => {
    const result = plan(
      "Сегодня в 19:00 запись Больше Zoom. В 18:30 напомни начать всё настраивать. После записи, если не будет созвона по коротким видео, я хочу сделать часовой велосипед во второй зоне очень легко. Созвон по коротким видео возможен около 19:30, пока не точно.",
      "2026-05-27T12:51:00.000Z",
    );

    expect(result.intent).toBe("plan");
    expect(result.actions.map((action) => action.actionType)).toEqual([
      "preparation",
      "event",
      "tentative_event",
      "training",
    ]);
    expect(result.actions[0].dueAtLocal).toBe("2026-05-27T18:30:00");
    expect(result.actions[0].reminders.map((reminder) => reminder.scheduledAtLocal)).toContain(
      "2026-05-27T18:30:00",
    );
    expect(result.actions[1].title).toBe("Запись Больше Zoom");
    expect(result.actions[1].startAtLocal).toBe("2026-05-27T19:00:00");
    expect(result.actions[2].kind).toBe("tentative_event");
    expect(result.actions[2].startAtLocal).toBe("2026-05-27T19:30:00");
    expect(result.actions[3].kind).toBe("training");
    expect(result.actions[3].durationMinutes).toBe(60);
  });

  it("extracts today's basketball call with sane future reminders", () => {
    const result = plan(
      "Сегодня созвон в 17.00 по русскому баскетболу",
      "2026-05-27T12:51:00.000Z",
    );

    expect(result.actions).toHaveLength(1);
    const [event] = result.actions;
    expect(event.kind).toBe("event");
    expect(event.title.toLowerCase()).toContain("русскому баскетболу");
    expect(event.startAtLocal).toBe("2026-05-27T17:00:00");
    expect(event.endAtLocal).toBe("2026-05-27T18:00:00");
    expect(event.reminders.every((reminder) => reminder.scheduledAtLocal! > "2026-05-27T15:51:00")).toBe(true);
  });

  it("extracts setup, Zoom event, tentative call, training, and followups", () => {
    const result = plan(
      "У меня сегодня запись Больше Zoom в 19:00. Напомни мне, что в 18:30 нужно уже идти всё настраивать. И после этого в 19:30, возможно, будет еще один созвон по коротким видео, но, скорее всего, я пойду делать тренировку. Сегодня у меня часовой велосипед во второй зоне в очень лайтовом режиме.",
      "2026-05-27T12:51:00.000Z",
    );

    expect(result.actions.map((action) => action.actionType)).toEqual([
      "preparation",
      "event",
      "tentative_event",
      "training",
    ]);
    expect(result.actions[0].dueAtLocal).toBe("2026-05-27T18:30:00");
    expect(result.actions[1].title).toContain("Больше Zoom");
    expect(result.actions[1].startAtLocal).toBe("2026-05-27T19:00:00");
    expect(result.actions[2].tentative).toBe(true);
    expect(result.actions[2].reminders.some((reminder) => reminder.scheduledAtLocal === "2026-05-27T19:20:00")).toBe(true);
    expect(result.actions[3].title).toContain("Z2");
    expect(result.actions[3].durationMinutes).toBe(60);
  });

  it("creates recurring reels reminder on requested weekdays with until-ack behavior", () => {
    const result = plan(
      "Напоминать о рилзах по F1 и MMA каждое утро в понедельник, вторник, среду и пятницу",
      "2026-05-27T12:00:00.000Z",
    );

    const [recurring] = result.actions;
    expect(recurring.kind).toBe("recurring_task");
    expect(recurring.recurrence?.daysOfWeek).toEqual(["MO", "TU", "WE", "FR"]);
    expect(recurring.recurrence?.timeLocal).toBe("09:30");
    expect(recurring.recurrence?.repeatUntilAck).toBe(true);
    expect(recurring.reminders[0].type).toBe("recurring");
    expect(recurring.reminders[0].repeatUntilAck).toBe(true);
    expect(recurring.reminders[0].payload.buttons).toEqual([
      "done_today",
      "snooze",
      "skip_today",
      "stop_recurring",
    ]);
  });

  it("keeps a night-on-Friday sports broadcast at 03:30 on Friday", () => {
    const result = plan(
      "Я комментирую матч Сан-Антонио — Оклахома, игра 6. Он начнётся в 3:30 по Москве в ночь на пятницу.",
      "2026-06-01T10:00:00.000Z",
    );

    const [event] = result.actions;
    expect(event.kind).toBe("event");
    expect(event.title).toContain("Комментирование матча Сан-Антонио");
    expect(event.startAtLocal).toBe("2026-06-05T03:30:00");
    expect(event.startAtLocal).not.toContain("15:30");
    expect(event.reminders.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps NBA night event at 03:30, never 15:30", () => {
    const result = plan(
      "Я комментирую матч Сан-Антонио Оклахома, игра номер 6. Он начнется в 3.00 по Москве, так что после эфира я поеду на… а, в 3.30 по Москве, да, после эфира поеду на него.",
      "2026-05-27T13:34:00.000Z",
    );

    const [event] = result.actions;
    expect(event.kind).toBe("event");
    expect(event.title).toContain("Сан-Антонио");
    expect(event.startAtLocal).toBe("2026-05-28T03:30:00");
    expect(event.startAtLocal).not.toContain("15:30");
    expect(event.memoryCandidates.some((memory) => memory.content.includes("03:00"))).toBe(true);
  });

  it("creates daily repeat-until-ack vitamins reminder", () => {
    const result = plan(
      "Каждое утро напоминай мне пить витамины, пока я не подтвержу",
      "2026-05-27T13:00:00.000Z",
    );

    const [recurring] = result.actions;
    expect(recurring.kind).toBe("recurring_task");
    expect(recurring.recurrence?.frequency).toBe("daily");
    expect(recurring.recurrence?.repeatUntilAck).toBe(true);
    expect(recurring.reminders[0].repeatUntilAck).toBe(true);
  });

  it("stores correction rules as memory-only planner output", () => {
    const result = plan(
      "Запомни: если я говорю про NBA в 3:00 или 3:30 по Москве, почти всегда это ночной прямой эфир, а не дневное событие.",
      "2026-05-27T13:00:00.000Z",
    );

    expect(result.intent).toBe("answer");
    expect(result.actions).toHaveLength(0);
    expect(result.memoryCandidates).toHaveLength(1);
    expect(result.memoryCandidates[0].category).toBe("meeting_pattern");
    expect(result.memoryCandidates[0].content).toContain("NBA");
    expect(result.memoryCandidates[0].searchTags).toContain("03:30");
  });
});
