import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import { importanceLabel, importanceMarker } from "@/domain/importance";
import { parseRussianWeekdayAppointment } from "@/domain/russianWeekday";
import { classifyTimelineItem } from "@/domain/timelineClassification";
import type { PlannerItem } from "@/db/schema";
import { requiresCampaignCompletionClarification } from "@/services/campaignLifecycle";

const now = new Date("2026-06-11T09:00:00.000Z");

describe("V2.5.2 universal editability and temporal safety", () => {
  it("parses a bare Russian weekday as the next future occurrence", () => {
    expect(
      parseRussianWeekdayAppointment({
        text: "Отвести Роба к ортодонту во вторник к 10.20",
        timezone: "Europe/Moscow",
        now,
      }),
    ).toEqual(
      expect.objectContaining({
        weekday: 2,
        hour: 10,
        minute: 20,
        localDateTime: "2026-06-16T10:20:00",
      }),
    );
  });

  it("creates a health event with automatic importance metadata", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: agentExecutionSchema.parse(emptyExecution()),
      text: "Отвести Роба к ортодонту во вторник к 10.20",
      timezone: "Europe/Moscow",
      now,
      activeContext: "none",
    });
    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({
        title: "Отвести Роба к ортодонту",
        startAtLocal: "2026-06-16T10:20:00",
        priority: 4,
        metadata: expect.objectContaining({
          category: "health",
          importanceMode: "auto",
          basePriority: 4,
        }),
      }),
    );
  });

  it("repairs an existing orthodontist item instead of creating a duplicate", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const execution = normalizeAgentExecutionProposal({
      execution: agentExecutionSchema.parse(emptyExecution()),
      text: "Отвести Роба к ортодонту во вторник к 10.20",
      timezone: "Europe/Moscow",
      now,
      activeContext: `- id=${id}; 2026-06-13 10:20: event Отвести Роба к ортодонту`,
    });
    expect(execution.actionPlan).toBeNull();
    expect(execution.itemUpdates[0]).toEqual(
      expect.objectContaining({
        itemIds: [id],
        operation: "reschedule",
        startAtLocal: "2026-06-16T10:20:00",
      }),
    );
  });

  it("uses human importance labels and campaign semantic classes", () => {
    expect(importanceLabel(5)).toBe("Очень важная");
    expect(importanceMarker(4)).toBe("⭐ Важно");
    expect(classifyTimelineItem({ item: campaignItem() }, now, "Europe/Moscow")).toBe(
      "campaign_active",
    );
  });

  it("requires clarification before completing a future campaign event", () => {
    expect(requiresCampaignCompletionClarification(campaignItem(), now)).toBe(true);
  });
});

function emptyExecution() {
  return {
    intent: "clarify",
    reply: "Уточни.",
    actionPlan: null,
    viewScope: null,
    resetMode: null,
    itemUpdates: [],
    reminderPolicies: [],
    memoryFacts: [],
    clarificationQuestions: [],
  };
}

function campaignItem(): PlannerItem {
  return {
    id: "item",
    userId: "user",
    pendingActionId: null,
    kind: "event",
    status: "active",
    title: "Студия Central Park",
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: new Date("2026-06-18T17:00:00.000Z"),
    endAt: new Date("2026-06-18T19:00:00.000Z"),
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "event",
    visibility: "active",
    sourcePolicyId: null,
    priority: 5,
    source: "telegram",
    metadata: { campaignGroup: "central_park", campaignState: "active" },
    createdAt: now,
    updatedAt: now,
  };
}
