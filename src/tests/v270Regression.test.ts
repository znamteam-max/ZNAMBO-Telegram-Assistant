import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import {
  buildValidationFailureReply,
  validateReminderPoliciesBeforeSave,
} from "@/ai/antiGarbageValidator";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import type { ExternalCalendarEvent, PlannerItem } from "@/db/schema";
import {
  classifyExternalCalendarEventHygiene,
  DEFAULT_EXTERNAL_CALENDAR_VISIBILITY,
  shouldShowExternalCalendarEvent,
} from "@/services/externalCalendarHygiene";
import { detectPlanConflicts } from "@/services/planConflicts";
import { buildUserTimelineViewFromData } from "@/services/userTimeline";

const now = new Date("2026-06-13T04:09:00.000Z");
const timezone = "Europe/Moscow";

describe("V2.7.0 reminder capture and calendar hygiene", () => {
  it("normalizes a clear 08:00 reminder after the mandatory AI proposal", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text: "В 8.00 напомни мне выйти из дома",
      timezone,
      now,
      activeContext: "none",
    });

    expect(execution.intent).toBe("create_plan");
    expect(execution.actionPlan?.actions).toEqual([
      expect.objectContaining({
        kind: "task",
        title: "Выйти из дома",
        dueAtLocal: "2026-06-13T08:00:00",
        reminders: [
          expect.objectContaining({
            scheduledAtLocal: "2026-06-13T08:00:00",
          }),
        ],
      }),
    ]);
  });

  it("normalizes a one-time reminder in one hour", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text: "Напомни через час оплатить шорты",
      timezone,
      now,
      activeContext: "none",
    });

    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({
        title: "Оплатить шорты",
        reminders: [
          expect.objectContaining({ scheduledAtLocal: "2026-06-13T08:09:00" }),
        ],
      }),
    );
  });

  it("creates an open-ended hourly nag without requiring an end time", () => {
    const text =
      "Напомни мне сегодня оплатить 3200 леи за шорты. Напоминай мне до тех пор, пока я не оплачу.";
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text,
      timezone,
      now,
      activeContext: "none",
    });

    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({ title: "Оплатить 3200 леи за шорты", kind: "task" }),
    );
    expect(execution.reminderPolicies).toEqual([
      expect.objectContaining({
        policyType: "nag_until_ack",
        endsAtLocal: null,
        intervalMinutes: 60,
        requireAck: true,
      }),
    ]);
    expect(
      validateReminderPoliciesBeforeSave({
        plan: execution.actionPlan!,
        policies: execution.reminderPolicies,
        timezone,
        originalMessage: text,
      }),
    ).toEqual({ ok: true, warnings: [] });
  });

  it("does not collapse an existing multi-action OpenAI plan into one reminder", () => {
    const base = normalizeAgentExecutionProposal({
      execution: agentExecutionSchema.parse({
        ...emptyExecution(),
        intent: "create_plan",
        actionPlan: {
          intent: "plan",
          summary: "Вечерний план",
          reply: null,
          confidence: 0.95,
          requiresConfirmation: false,
          actions: [
            action("Запись Больше Zoom", "event"),
            action("Велосипед Z2", "training"),
          ],
          memoryCandidates: [],
          clarificationQuestions: [],
        },
      }),
      text: "Сегодня в 19:00 запись Больше Zoom. В 18:30 напомни начать всё настраивать. После записи, если не будет созвона, хочу сделать велосипед Z2.",
      timezone,
      now,
      activeContext: "none",
    });

    expect(base.actionPlan?.actions).toHaveLength(2);
    expect(base.actionPlan?.actions.map((item) => item.title)).toEqual([
      "Запись Больше Zoom",
      "Велосипед Z2",
    ]);
  });

  it("returns a precise reminder clarification instead of generic ambiguity", () => {
    const reply = buildValidationFailureReply([
      "explicit reminder intent has no committed policy",
    ]);
    expect(reply).toContain("не понял время напоминания");
    expect(reply).not.toContain("мусор");
    expect(reply).not.toContain("неоднознач");
  });

  it("hides service and past external events by default", () => {
    const service = externalEvent({
      summary: "ZNAMBO CalDAV write verification",
      uid: "calendar-test-1",
      startAt: new Date("2026-06-13T08:00:00.000Z"),
      endAt: new Date("2026-06-13T08:05:00.000Z"),
    });
    const past = externalEvent({
      id: "past",
      summary: "Роберт | Хор",
      uid: "real-event",
      startAt: new Date("2026-06-11T15:10:00.000Z"),
      endAt: new Date("2026-06-11T16:20:00.000Z"),
    });

    expect(classifyExternalCalendarEventHygiene(service, now).isServiceEvent).toBe(true);
    expect(
      shouldShowExternalCalendarEvent({
        event: service,
        preferences: DEFAULT_EXTERNAL_CALENDAR_VISIBILITY,
        now,
      }),
    ).toBe(false);
    expect(
      shouldShowExternalCalendarEvent({
        event: past,
        preferences: DEFAULT_EXTERNAL_CALENDAR_VISIBILITY,
        now,
      }),
    ).toBe(false);
  });

  it("never places a past external event under Soon", () => {
    const past = externalEvent({
      id: "past",
      summary: "Роберт | Хор",
      uid: "real-event",
      startAt: new Date("2026-06-11T15:10:00.000Z"),
      endAt: new Date("2026-06-11T16:20:00.000Z"),
    });
    const timeline = buildUserTimelineViewFromData({
      items: [],
      policies: [],
      externalEvents: [past],
      timezone,
      now,
    });

    expect(timeline.byBucket.soon).toHaveLength(0);
    expect(timeline.byBucket.history.map((row) => row.entityRef.id)).toEqual(["past"]);
  });

  it("moves past external events into Unresolved only when past visibility is enabled", () => {
    const past = externalEvent({
      id: "past-visible",
      summary: "Прошедшая встреча",
      startAt: new Date("2026-06-12T07:00:00.000Z"),
      endAt: new Date("2026-06-12T08:00:00.000Z"),
      metadata: { showPastExternal: true },
    });
    const timeline = buildUserTimelineViewFromData({
      items: [],
      policies: [],
      externalEvents: [past],
      timezone,
      now,
    });

    expect(timeline.byBucket.soon).toHaveLength(0);
    expect(timeline.byBucket.unresolvedPast.map((row) => row.entityRef.id)).toEqual([
      "past-visible",
    ]);
  });

  it("ignores hidden, service, and ended events in conflicts but keeps real future overlaps", () => {
    const future = plannerItem({
      id: "future",
      title: "Студия Central Park",
      startAt: new Date("2026-06-16T05:00:00.000Z"),
      endAt: new Date("2026-06-16T09:00:00.000Z"),
    });
    const futureOverlap = plannerItem({
      id: "future-overlap",
      title: "Отвести Роба к ортодонту",
      startAt: new Date("2026-06-16T07:20:00.000Z"),
    });
    const service = plannerItem({
      id: "service",
      title: "ZNAMBO CalDAV write verification",
      startAt: new Date("2026-06-16T07:30:00.000Z"),
      metadata: { isServiceEvent: true },
    });
    const past = plannerItem({
      id: "past",
      title: "Past",
      startAt: new Date("2026-06-12T07:00:00.000Z"),
      endAt: new Date("2026-06-12T08:00:00.000Z"),
    });

    const conflicts = detectPlanConflicts([future, futureOverlap, service, past], { now });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].first.id).toBe("future");
    expect(conflicts[0].second.id).toBe("future-overlap");
  });
});

function emptyExecution() {
  return agentExecutionSchema.parse({
    intent: "clarify",
    reply: "Уточни.",
    actionPlan: null,
    viewScope: null,
    resetMode: null,
    itemUpdates: [],
    reminderPolicies: [],
    memoryFacts: [],
    clarificationQuestions: ["Уточни."],
  });
}

function externalEvent(overrides: Partial<ExternalCalendarEvent>): ExternalCalendarEvent {
  return {
    id: "external",
    userId: "user",
    provider: "yandex",
    calendarLabel: "Личный",
    calendarObjectUrl: "https://caldav.example/events/external.ics",
    uid: "external",
    etag: null,
    summary: "External",
    description: null,
    location: null,
    startAt: new Date("2026-06-15T08:00:00.000Z"),
    endAt: new Date("2026-06-15T09:00:00.000Z"),
    timezone,
    isRecurring: false,
    recurrenceRule: null,
    recurrenceId: "",
    exdates: [],
    source: "yandex_external",
    hiddenAt: null,
    lastSeenAt: now,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function plannerItem(overrides: Partial<PlannerItem>): PlannerItem {
  return {
    id: "item",
    userId: "user",
    pendingActionId: null,
    kind: "event",
    status: "active",
    title: "Event",
    description: null,
    location: null,
    timezone,
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "event",
    visibility: "active",
    sourcePolicyId: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function action(title: string, kind: "event" | "training") {
  return {
    actionType: kind,
    kind,
    title,
    description: null,
    location: null,
    timezone,
    startAtLocal: "2026-06-13T19:00:00",
    endAtLocal: null,
    dueAtLocal: null,
    durationMinutes: null,
    priority: 3,
    confidence: 0.95,
    risk: "low" as const,
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: {},
  };
}
