import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createStoredActionPlan: vi.fn(),
  commitStoredActionPlan: vi.fn(),
  replyAndRecord: vi.fn(),
}));

vi.mock("@/services/actionPlanCommit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/actionPlanCommit")>();
  return {
    ...actual,
    createStoredActionPlan: mocks.createStoredActionPlan,
    commitStoredActionPlan: mocks.commitStoredActionPlan,
  };
});
vi.mock("@/bot/reply", () => ({
  replyAndRecord: mocks.replyAndRecord,
}));

import { executeActionPlanForMessage } from "@/bot/messagePipeline";
import type { BotContext } from "@/bot/context";
import { actionPlanSchema } from "@/ai/schemas";

describe("V2.4.2 atomic agent execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replyAndRecord.mockResolvedValue({ message_id: 1 });
  });

  it("normalizes an AI UTC-shifted wall clock before storing ActionPlan JSON", async () => {
    const ctx = {
      owner: { id: "11111111-1111-4111-8111-111111111111", smartCommitMode: "confirm_all" },
      update: { update_id: 42 }, dbMessageId: "22222222-2222-4222-8222-222222222222",
    } as unknown as BotContext;
    mocks.createStoredActionPlan.mockRejectedValueOnce(new Error("stop_after_capture"));
    await expect(executeActionPlanForMessage(ctx, {
      text: "Созвон по Взял Мчч в 18.00", timezone: "Europe/Moscow",
      now: new Date("2026-09-03T06:00:00Z"), activeContext: "none", forceCommit: false,
      plan: actionPlanSchema.parse({ actions: [{
        actionType: "event", kind: "event", title: "Тестовый созвон",
        timezone: "Europe/Moscow", startAtLocal: "2026-09-03T15:00:00",
        endAtLocal: "2026-09-03T16:00:00",
      }] }),
    })).rejects.toThrow("stop_after_capture");
    expect(mocks.createStoredActionPlan.mock.calls[0][0].plan.actions[0]).toMatchObject({
      timezone: "Europe/Moscow", startAtLocal: "2026-09-03T18:00:00", endAtLocal: "2026-09-03T19:00:00",
    });
    expect(mocks.commitStoredActionPlan).not.toHaveBeenCalled();
  });

  it("performs zero DB commit work when policy validation fails", async () => {
    const ctx = {
      owner: {
        id: "11111111-1111-4111-8111-111111111111",
        smartCommitMode: "auto_low_risk",
      },
      update: { update_id: 42 },
      reply: vi.fn(),
      dbMessageId: "22222222-2222-4222-8222-222222222222",
    } as unknown as BotContext;

    const result = await executeActionPlanForMessage(ctx, {
      text: "Создай встречу, но schedule неоднозначен",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-09T05:00:00.000Z"),
      activeContext: "none",
      forceCommit: true,
      plan: {
        intent: "plan",
        summary: "One event",
        reply: null,
        confidence: 0.95,
        requiresConfirmation: false,
        actions: [
          {
            actionType: "event",
            kind: "event",
            title: "Студия Central Park",
            description: null,
            location: null,
            timezone: "Europe/Moscow",
            startAtLocal: "2026-06-11T20:00:00",
            endAtLocal: "2026-06-11T22:00:00",
            dueAtLocal: null,
            durationMinutes: null,
            priority: 5,
            confidence: 0.95,
            risk: "low",
            requiresConfirmation: false,
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
        {
          operation: "create_recurring_policy",
          itemIds: [],
          itemTitle: "Несуществующая встреча",
          title: "Неоднозначное напоминание",
          category: "meeting",
          policyType: "recurring",
          startsAtLocal: "2026-06-09T10:00:00",
          endsAtLocal: "2026-06-11T18:00:00",
          nextFireAtLocal: "2026-06-09T10:00:00",
          recurrenceRule: "daily_at_10:00",
          intervalMinutes: null,
          requireAck: false,
          maxOccurrences: null,
          minutesBefore: null,
          windowEndInclusive: true,
          catchUpMode: "latest_only",
          onWindowEnd: "expire_silently",
          quietHoursStart: null,
          quietHoursEnd: null,
          allowDuringQuietHours: false,
        },
      ],
    });

    expect(result.finalAction).toBe("blocked_by_anti_garbage_validator");
    expect(result.transactionStarted).toBe(false);
    expect(result.committedMutationCount).toBe(0);
    expect(result.partialMutationDetected).toBe(false);
    expect(mocks.createStoredActionPlan).not.toHaveBeenCalled();
    expect(mocks.commitStoredActionPlan).not.toHaveBeenCalled();
  });
});
