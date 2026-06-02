import { describe, expect, it } from "vitest";

import { validatePlannerItemsBeforeSave } from "@/ai/antiGarbageValidator";
import { decideUserIntentDeterministic } from "@/ai/assistantDecision";
import type { ActionPlan } from "@/ai/schemas";
import { formatItemList, formatReminderMessage } from "@/bot/formatters";
import type { PlannerItem, Reminder } from "@/db/schema";
import { buildActionPlanFromDecision } from "@/services/assistantPlanBuilders";

const timezone = "Europe/Moscow";
const now = new Date("2026-06-02T09:00:00.000Z");

describe("assistant intent-first decision pipeline", () => {
  it("treats edit task requests as management, not a new task", () => {
    const decision = decideUserIntentDeterministic({
      text: "Дай отредактирую текущие задачи",
      timezone,
      now,
    });

    expect(decision.intent).toBe("manage_existing_items");
    expect(decision.shouldCreateItems).toBe(false);
  });

  it("splits an ordered task list into separate floating items with preserved order", () => {
    const text = [
      "На сегодня дела по порядку:",
      "",
      "* Зумы РГ",
      "* рилзы ЧМ",
      "* комментаторы НХЛ",
      "* созвон НХЛ",
      "* созвон ВМ",
      "* созвон ВС",
    ].join("\n");
    const decision = decideUserIntentDeterministic({ text, timezone, now });
    const plan = buildActionPlanFromDecision({ decision, text, timezone, now });

    expect(decision.intent).toBe("ordered_task_list");
    expect(plan?.actions).toHaveLength(6);
    expect(plan?.actions.map((action) => action.title)).toEqual([
      "Зумы РГ",
      "рилзы ЧМ",
      "комментаторы НХЛ",
      "созвон НХЛ",
      "созвон ВМ",
      "созвон ВС",
    ]);
    expect(plan?.actions[3].metadata.itemType).toBe("call");
    expect(plan?.actions[5].metadata.orderIndex).toBe(6);
    expect(plan?.actions.some((action) => action.kind === "event" && !action.startAtLocal)).toBe(false);
  });

  it("stores missed cycling as reports and tomorrow Holmy as tentative training", () => {
    const text =
      "К сожалению, сегодня и вчера без велика. Завтра постараюсь поехать утром/днём на Холмы, и сделать лонг на 50-70 км";
    const decision = decideUserIntentDeterministic({ text, timezone, now });
    const plan = buildActionPlanFromDecision({ decision, text, timezone, now });

    expect(decision.intent).toBe("training_report");
    expect(decision.trainingReport?.dateRefs).toHaveLength(2);
    expect(decision.tentativePlan?.title).toBe("Холмы 50-70 км");
    expect(plan?.actions.map((action) => action.kind)).toEqual(["note", "note", "training"]);
    const training = plan?.actions[2];
    expect(training?.title).not.toBe(text);
    expect(training?.tentative).toBe(true);
    expect(training?.metadata.timeUnspecified).toBe(true);
    expect(training?.dueAtLocal).toBe("2026-06-03T08:00:00");
    expect(training?.dueAtLocal).not.toContain("10:00");
  });

  it("does not allow command text or full bullet lists to be saved as item titles", () => {
    const badPlan: ActionPlan = {
      intent: "plan",
      summary: null,
      reply: null,
      confidence: 0.8,
      requiresConfirmation: false,
      memoryCandidates: [],
      clarificationQuestions: [],
      actions: [
        {
          actionType: "task",
          kind: "task",
          title: "Дай отредактирую текущие задачи",
          description: null,
          location: null,
          timezone,
          startAtLocal: null,
          endAtLocal: null,
          dueAtLocal: null,
          durationMinutes: null,
          priority: 3,
          confidence: 0.8,
          risk: "low",
          requiresConfirmation: false,
          tentative: false,
          recurrence: null,
          reminders: [],
          memoryCandidates: [],
          metadata: {},
        },
      ],
    };

    const result = validatePlannerItemsBeforeSave({
      plan: badPlan,
      originalMessage: "Дай отредактирую текущие задачи",
    });

    expect(result.ok).toBe(false);
    expect(result.warnings).toContain("management command was converted into an item title");
  });

  it("formats tentative follow-up as happened-or-cancelled question", () => {
    const item = {
      id: "item-id",
      kind: "tentative_event",
      title: "Возможный созвон по коротким видео",
      timezone,
      startAt: new Date("2026-06-02T16:30:00.000Z"),
      endAt: null,
      dueAt: null,
      metadata: { tentative: true },
    } as PlannerItem;
    const reminder = { type: "followup", repeatUntilAck: false } as Reminder;

    const text = formatReminderMessage(reminder, item);

    expect(text).toContain("был или отменился");
    expect(text).not.toContain("Как прошла встреча");
  });

  it("shows tentative training plans in day views instead of empty output", () => {
    const item = {
      id: "training-id",
      kind: "training",
      title: "Холмы 50-70 км",
      timezone,
      startAt: null,
      endAt: null,
      dueAt: new Date("2026-06-03T05:00:00.000Z"),
      metadata: { tentativeTrainingPlan: true, timeUnspecified: true },
    } as PlannerItem;

    const text = formatItemList("Сегодня", [item], timezone);

    expect(text).toContain("Холмы 50-70 км");
    expect(text).toContain("предварительно");
    expect(text).not.toContain("Пусто");
  });

  it("treats memory correction as memory_update", () => {
    const decision = decideUserIntentDeterministic({
      text: "Запомни: если я говорю про NBA в 3:00 или 3:30 по Москве, почти всегда это ночной прямой эфир, а не дневное событие.",
      timezone,
      now,
    });

    expect(decision.intent).toBe("memory_update");
    expect(decision.shouldCreateItems).toBe(false);
    expect(decision.memoryFacts[0].searchTags).toContain("03:30");
  });

  it.each([
    "покажи задачи",
    "что у меня сегодня",
    "открой текущие дела",
    "дай отредактирую",
  ])("does not create tasks for command-like text: %s", (text) => {
    const decision = decideUserIntentDeterministic({ text, timezone, now });
    expect(decision.shouldCreateItems).toBe(false);
  });
});
