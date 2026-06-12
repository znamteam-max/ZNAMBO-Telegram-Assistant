import { describe, expect, it } from "vitest";

import { detectHardManagementIntent } from "@/agent/hardManagementIntent";
import type { PlannerItem } from "@/db/schema";
import { detectPlanConflicts } from "@/services/planConflicts";
import { parseItemEditMutation } from "@/services/itemEditMutations";
import { parseRussianDateTime } from "@/services/russianDateTime";

describe("V2.5.4.1 item edit sessions", () => {
  const now = new Date("2026-06-12T14:10:00.000Z");

  it.each([
    ["на понедельник 8 утра", "2026-06-15 08:00"],
    ["в понедельник в 8", "2026-06-15 08:00"],
    ["во вторник к 10.20", "2026-06-16 10:20"],
  ])("parses %s from Friday afternoon", (text, expected) => {
    const parsed = parseRussianDateTime({
      text,
      timezone: "Europe/Moscow",
      now,
    });

    expect(parsed?.local.toFormat("yyyy-LL-dd HH:mm")).toBe(expected);
    expect(parsed?.pastConfirmationRequired).toBe(false);
  });

  it("asks for confirmation when explicit today time is already in the past", () => {
    const parsed = parseRussianDateTime({
      text: "сегодня в 8 утра",
      timezone: "Europe/Moscow",
      now,
    });

    expect(parsed?.local.toFormat("yyyy-LL-dd HH:mm")).toBe("2026-06-12 08:00");
    expect(parsed?.pastConfirmationRequired).toBe(true);
  });

  it("turns the orthodontist edit into one compound mutation for the active item", () => {
    const text =
      'Изменить на "Перенести визит Роба к ортодонту", поставь это на понедельник, напоминай в понедельник раз в час с 8 утра, пока не сделаю';

    expect(detectHardManagementIntent(text)?.intent).toBe("reschedule_by_indices");

    const mutation = parseItemEditMutation({
      text,
      item: makeItem(),
      timezone: "Europe/Moscow",
      now,
    });

    expect(mutation).toEqual(
      expect.objectContaining({
        itemId: "orthodontist",
        title: "Перенести визит Роба к ортодонту",
        kind: "event",
        scheduledForLocal: "2026-06-15T08:00:00+03:00",
        changedFields: ["title", "kind", "schedule", "reminder_policy"],
        pastConfirmationRequired: false,
      }),
    );
    expect(mutation.reminderPolicy).toEqual({
      policyType: "nag_until_ack",
      startsAtLocal: "2026-06-15T08:00:00+03:00",
      intervalMinutes: 60,
      activeWindowStart: "08:00",
      stopCondition: "until_done",
    });
  });

  it("uses explicit date and time without requiring a numbered list index", () => {
    const mutation = parseItemEditMutation({
      text: "15.06 на 8 утра",
      item: makeItem(),
      timezone: "Europe/Moscow",
      now,
    });

    expect(mutation.changedFields).toEqual(["schedule"]);
    expect(mutation.scheduledForLocal).toBe("2026-06-15T08:00:00+03:00");
  });

  it("conflict detection disappears after moving the edited item off the overlap", () => {
    const orthodontist = makeEvent("orthodontist", "Ортодонт", "2026-06-16T07:00:00.000Z", 60);
    const call = makeEvent("call", "Созвон", "2026-06-16T07:30:00.000Z", 60);
    expect(detectPlanConflicts([orthodontist, call])).toHaveLength(1);

    const moved = {
      ...orthodontist,
      startAt: new Date("2026-06-15T05:00:00.000Z"),
      endAt: new Date("2026-06-15T06:00:00.000Z"),
    };
    expect(detectPlanConflicts([moved, call])).toHaveLength(0);

    const movedBack = {
      ...orthodontist,
      startAt: new Date("2026-06-16T07:00:00.000Z"),
      endAt: new Date("2026-06-16T08:00:00.000Z"),
    };
    expect(detectPlanConflicts([movedBack, call])).toHaveLength(1);
  });
});

function makeItem(): PlannerItem {
  const timestamp = new Date("2026-06-12T14:00:00.000Z");
  return {
    id: "orthodontist",
    userId: "user-id",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Визит Роба к ортодонту",
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: null,
    endAt: null,
    dueAt: new Date("2026-06-16T07:20:00.000Z"),
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: null,
    visibility: "active",
    sourcePolicyId: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeEvent(id: string, title: string, startIso: string, durationMinutes: number): PlannerItem {
  const timestamp = new Date("2026-06-12T14:00:00.000Z");
  const startAt = new Date(startIso);
  return {
    id,
    userId: "user-id",
    pendingActionId: null,
    kind: "event",
    status: "active",
    title,
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt,
    endAt: new Date(startAt.getTime() + durationMinutes * 60 * 1000),
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: null,
    visibility: "active",
    sourcePolicyId: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
