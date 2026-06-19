import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { agentExecutionSchema, type AgentReminderPolicy } from "@/ai/schemas/agentExecution";
import { formatActionPlanCard } from "@/bot/formatters";
import {
  detectOpenEndedUntilDoneIntent,
  extractOpenEndedUntilDoneTitle,
} from "@/domain/openEndedUntilDoneIntent";

const TIMEZONE = "Europe/Moscow";
const NOW = new Date("2026-06-19T17:00:00.000Z");

describe("V2.27 until-done phrase order and action-plan guard fix", () => {
  it.each([
    [
      "Напоминай мне каждый час, пока не выполню, починить кран в ванной",
      "Починить кран в ванной",
      60,
      "cadence_before_title",
    ],
    [
      "Напоминай мне починить кран в ванной до тех пор, когда не сделаю, каждый час",
      "Починить кран в ванной",
      60,
      "title_before_stop_condition",
    ],
    [
      "Напоминай каждые 30 минут починить кран, пока не сделаю",
      "Починить кран",
      30,
      "cadence_before_title",
    ],
    [
      "Починить кран в ванной — напоминай каждый час, пока не сделаю",
      "Починить кран в ванной",
      60,
      "title_before_stop_condition",
    ],
    [
      "Пинай меня каждый час: починить кран в ванной, пока не выполню",
      "Починить кран в ванной",
      60,
      "cadence_before_title",
    ],
    [
      "Каждый час напоминай починить кран в ванной до тех пор пока не сделаю",
      "Починить кран в ванной",
      60,
      "cadence_before_title",
    ],
  ])(
    "normalizes reordered until-done phrase: %s",
    (text, expectedTitle, expectedInterval, expectedOrder) => {
      const detected = detectOpenEndedUntilDoneIntent({ text, timezone: TIMEZONE, now: NOW });
      expect(detected).toEqual(
        expect.objectContaining({
          title: expectedTitle,
          intervalMinutes: expectedInterval,
          stopCondition: "until_done",
          startsAtMode: "now",
          confidence: "high",
          sourceOrder: expectedOrder,
          endsAtLocal: null,
        }),
      );

      const execution = normalizeAgentExecutionProposal({
        execution: badAiRecurringExecution(expectedTitle),
        text,
        timezone: TIMEZONE,
        now: NOW,
        activeContext: "none",
      });
      const action = execution.actionPlan?.actions[0];
      const policy = execution.reminderPolicies[0];
      const preview = formatActionPlanCard(execution.actionPlan!, TIMEZONE);

      expect(execution.intent).toBe("create_plan");
      expect(execution.actionPlan?.actions).toHaveLength(1);
      expect(action).toEqual(
        expect.objectContaining({
          kind: "task",
          title: expectedTitle,
          startAtLocal: null,
          dueAtLocal: null,
          reminders: [],
          metadata: expect.objectContaining({
            sourceNormalization: "open_nag_until_ack_v2240",
            phraseOrderNormalization: "open_nag_until_ack_v2270",
            stopCondition: "until_done",
            intervalMinutes: expectedInterval,
            openEndedUntilDone: true,
            timeScope: "persistent",
            untilDoneAiProposalNormalized: true,
          }),
        }),
      );
      expect(policy).toEqual(
        expect.objectContaining({
          operation: "create_interval_window_policy",
          policyType: "nag_until_ack",
          intervalMinutes: expectedInterval,
          requireAck: true,
          startsAtLocal: "2026-06-19T20:05:00",
          nextFireAtLocal: "2026-06-19T20:05:00",
          endsAtLocal: null,
          onWindowEnd: "carry_to_next_day",
        }),
      );
      expect(preview).toContain("↻");
      expect(preview).toContain("пока не отмечу выполненным");
      expect(preview).not.toContain("без времени");
      expect(preview).not.toContain("missing_initial_fire");
    },
  );

  it("sanitizes the owner reordered title without inventing reminder wording", () => {
    expect(
      extractOpenEndedUntilDoneTitle(
        "Напоминай мне починить кран в ванной до тех пор, когда не сделаю, каждый час",
      ),
    ).toBe("Починить кран в ванной");
  });

  it("does not convert daily recurring without time into open-ended nag", () => {
    const text = "Каждый день напоминай мне решить вопрос с ЭЦП";
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text,
      timezone: TIMEZONE,
      now: NOW,
      activeContext: "none",
    });

    expect(detectOpenEndedUntilDoneIntent({ text, timezone: TIMEZONE, now: NOW })).toBeNull();
    expect(execution.reminderPolicies[0]).toEqual(
      expect.objectContaining({
        policyType: "recurring",
        recurrenceRule: "daily",
        nextFireAtLocal: null,
      }),
    );
    expect(execution.actionPlan?.requiresConfirmation).toBe(true);
  });

  it("does not convert weekly recurring without time into open-ended nag", () => {
    const text = "Каждый понедельник напоминай мне решить вопрос с зеркалом";
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text,
      timezone: TIMEZONE,
      now: NOW,
      activeContext: "none",
    });

    expect(detectOpenEndedUntilDoneIntent({ text, timezone: TIMEZONE, now: NOW })).toBeNull();
    expect(execution.reminderPolicies[0]).toEqual(
      expect.objectContaining({
        policyType: "recurring",
        recurrenceRule: "weekly:MO",
        nextFireAtLocal: null,
      }),
    );
    expect(execution.actionPlan?.requiresConfirmation).toBe(true);
  });

  it("keeps finite today until-done bounded to 23:59 local", () => {
    const text = "Напоминай мне сегодня каждый час до конца дня, пока не сделаю, купить зеркало";
    const execution = normalizeAgentExecutionProposal({
      execution: badAiRecurringExecution("Купить зеркало"),
      text,
      timezone: TIMEZONE,
      now: NOW,
      activeContext: "none",
    });

    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({
        title: "Купить зеркало",
        dueAtLocal: "2026-06-19T23:59:00",
        metadata: expect.objectContaining({
          openEndedUntilDone: false,
          timeScope: "today",
        }),
      }),
    );
    expect(execution.reminderPolicies[0]).toEqual(
      expect.objectContaining({
        policyType: "nag_until_ack",
        endsAtLocal: "2026-06-19T23:59:00",
        onWindowEnd: "move_to_overdue_or_review",
      }),
    );
  });

  it("keeps open-ended until-done persistent", () => {
    const text = "Напоминай мне каждый час, пока не сделаю, купить зеркало";
    const execution = normalizeAgentExecutionProposal({
      execution: badAiRecurringExecution("Купить зеркало"),
      text,
      timezone: TIMEZONE,
      now: NOW,
      activeContext: "none",
    });

    expect(execution.actionPlan?.actions[0]?.dueAtLocal).toBeNull();
    expect(execution.reminderPolicies[0]).toEqual(
      expect.objectContaining({
        policyType: "nag_until_ack",
        endsAtLocal: null,
      }),
    );
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

function badAiRecurringExecution(title: string) {
  return agentExecutionSchema.parse({
    ...emptyExecution(),
    intent: "create_plan",
    actionPlan: {
      intent: "plan",
      summary: title,
      reply: null,
      confidence: 0.82,
      requiresConfirmation: true,
      actions: [
        {
          actionType: "task",
          kind: "task",
          title,
          description: null,
          location: null,
          timezone: TIMEZONE,
          startAtLocal: null,
          endAtLocal: null,
          dueAtLocal: null,
          durationMinutes: null,
          priority: 3,
          confidence: 0.82,
          risk: "low",
          requiresConfirmation: true,
          tentative: false,
          recurrence: null,
          reminders: [],
          memoryCandidates: [],
          metadata: {},
        },
      ],
      memoryCandidates: [],
      clarificationQuestions: [],
    },
    reminderPolicies: [
      policy({
        operation: "create_recurring_policy",
        policyType: "recurring",
        itemTitle: title,
        title,
        startsAtLocal: null,
        nextFireAtLocal: null,
        recurrenceRule: null,
        intervalMinutes: 60,
        requireAck: true,
      }),
    ],
  });
}

function policy(overrides: Partial<AgentReminderPolicy> = {}): AgentReminderPolicy {
  return {
    operation: "create_recurring_policy",
    itemIds: [],
    itemTitle: null,
    title: "Напоминание",
    category: "nag_until_done",
    policyType: "recurring",
    startsAtLocal: null,
    endsAtLocal: null,
    nextFireAtLocal: null,
    recurrenceRule: null,
    intervalMinutes: null,
    requireAck: false,
    maxOccurrences: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
    ...overrides,
  };
}
