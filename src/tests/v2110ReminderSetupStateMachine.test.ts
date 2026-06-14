import { beforeEach, describe, expect, it, vi } from "vitest";

const repairMocks = vi.hoisted(() => ({
  listManageableItems: vi.fn(),
  updatePlannerItemSchedule: vi.fn(),
  listActiveReminderPolicies: vi.fn(),
  updateReminderPolicy: vi.fn(),
  cancelPendingRemindersForPolicy: vi.fn(),
  listPendingAgentActionsByTypes: vi.fn(),
  updateAgentAction: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/db/queries/items", () => ({
  listManageableItems: repairMocks.listManageableItems,
  updatePlannerItemSchedule: repairMocks.updatePlannerItemSchedule,
}));
vi.mock("@/db/queries/reminderPolicies", () => ({
  listActiveReminderPolicies: repairMocks.listActiveReminderPolicies,
  updateReminderPolicy: repairMocks.updateReminderPolicy,
}));
vi.mock("@/db/queries/reminders", () => ({
  cancelPendingRemindersForPolicy: repairMocks.cancelPendingRemindersForPolicy,
}));
vi.mock("@/db/queries/agentActions", () => ({
  listPendingAgentActionsByTypes: repairMocks.listPendingAgentActionsByTypes,
  updateAgentAction: repairMocks.updateAgentAction,
}));
vi.mock("@/db/queries/audit", () => ({
  writeAudit: repairMocks.writeAudit,
}));

import {
  materializeReminderPolicyDraft,
  parseReminderPolicyDraftInput,
} from "@/bot/reminderPolicyEditFlow";
import { isGlobalCreationIntent, isSessionCancelText } from "@/bot/sessionRouting";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";
import {
  applyV2110ProductionRepair,
  isV2110KnownWorldCupRecapTask,
  isV2110WrongWorldCupDueAt,
  previewV2110ProductionRepair,
  v2110ExpectedWorldCupDueAt,
} from "@/services/v2110ProductionRepair";

const timezone = "Europe/Moscow";
const now = new Date("2026-06-14T11:43:00.000Z");

describe("V2.11.0 reminder setup state machine and session escape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repairMocks.listManageableItems.mockResolvedValue([]);
    repairMocks.listActiveReminderPolicies.mockResolvedValue([]);
    repairMocks.listPendingAgentActionsByTypes.mockResolvedValue([]);
    repairMocks.writeAudit.mockResolvedValue(undefined);
  });

  it("collects reminder cadence fields and lets end-of-day finish the draft", () => {
    const first = parseReminderPolicyDraftInput(
      "С 20.00 каждые полчаса, пока не отмечу",
    );
    expect(first).toEqual({
      intervalMinutes: 30,
      windowStart: "20:00",
      windowEnd: undefined,
      windowEndDayOffset: undefined,
    });

    const end = parseReminderPolicyDraftInput("До конца дня");
    expect(end.windowEnd).toBe("23:59");

    const materialized = materializeReminderPolicyDraft({
      draft: {
        intervalMinutes: first.intervalMinutes,
        windowStart: first.windowStart,
        windowEnd: end.windowEnd,
        stopCondition: "until_done",
      },
      timezone,
      now,
      itemAnchor: v2110ExpectedWorldCupDueAt(),
    });
    expect(materialized).toEqual(
      expect.objectContaining({
        intervalMinutes: 30,
        startsAt: new Date("2026-06-14T17:00:00.000Z"),
        endsAt: new Date("2026-06-14T20:59:00.000Z"),
        windowStart: "20:00",
        windowEnd: "23:59",
      }),
    );
  });

  it("accepts numeric 23.59 and full end-of-today phrases without another prompt", () => {
    expect(parseReminderPolicyDraftInput("до 23.59").windowEnd).toBe("23:59");
    const full = parseReminderPolicyDraftInput(
      "С 20.00 каждые 30 мин, пока не отмечу, до конца сегодняшнего дня",
    );
    expect(full).toEqual({
      intervalMinutes: 30,
      windowStart: "20:00",
      windowEnd: "23:59",
      windowEndDayOffset: 0,
    });
    const materialized = materializeReminderPolicyDraft({
      draft: { ...full, stopCondition: "until_done" },
      timezone,
      now,
      itemAnchor: v2110ExpectedWorldCupDueAt(),
    });
    expect(materialized?.endsAt).toEqual(new Date("2026-06-14T20:59:00.000Z"));
  });

  it.each(["отмена", "отмени", "cancel", "/cancel", "стоп", "закрыть", "выйти", "не надо"])(
    "recognizes session cancellation: %s",
    (text) => {
      expect(isSessionCancelText(text)).toBe(true);
    },
  );

  it("routes new recurring reminders as global intents instead of stale item edits", () => {
    expect(
      isGlobalCreationIntent(
        "Напоминай мне каждый месяц 15, 16, 17, 18 и 19 числа внести показания счетчика",
      ),
    ).toBe(true);
    expect(
      isGlobalCreationIntent(
        "И напоминай мне каждый понедельник проверить и решить вопрос с зеркалом на машину",
      ),
    ).toBe(true);
    expect(isGlobalCreationIntent("Поменяй подготовку к ЧМ на 22:00")).toBe(false);
    expect(isGlobalCreationIntent("09:00")).toBe(false);
  });

  it("previews and applies the known production repair without touching calendar objects", async () => {
    const item = worldCupItem();
    const policy = intendedPolicy(item.id);
    const mirror = mirrorPolicy(item.id);
    const session = staleSession(item.id);
    repairMocks.listManageableItems.mockResolvedValue([item]);
    repairMocks.listActiveReminderPolicies.mockResolvedValue([policy, mirror]);
    repairMocks.listPendingAgentActionsByTypes.mockResolvedValue([session]);
    repairMocks.updatePlannerItemSchedule.mockResolvedValue({
      ...item,
      dueAt: v2110ExpectedWorldCupDueAt(),
    });
    repairMocks.updateReminderPolicy.mockImplementation((params) =>
      Promise.resolve({ id: params.policyId }),
    );
    repairMocks.updateAgentAction.mockResolvedValue(session);

    expect(isV2110KnownWorldCupRecapTask(item.title)).toBe(true);
    expect(isV2110WrongWorldCupDueAt(item.dueAt)).toBe(true);

    const preview = await previewV2110ProductionRepair({ userId: "user" });
    expect(preview).toEqual(
      expect.objectContaining({
        safeToApply: true,
        wrongDueAt: true,
        calendarObjectsToDelete: 0,
        intendedPolicyIds: [policy.id],
        unrelatedAttachedPolicyIds: [mirror.id],
        staleSessionIds: [session.id],
      }),
    );

    const result = await applyV2110ProductionRepair({ userId: "user" });
    expect(result.updatedItemIds).toEqual([item.id]);
    expect(result.normalizedPolicyIds).toEqual([policy.id]);
    expect(result.detachedPolicyIds).toEqual([mirror.id]);
    expect(result.clearedSessionIds).toEqual([session.id]);
    expect(result.calendarObjectsChanged).toBe(0);
    expect(repairMocks.updatePlannerItemSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: item.id,
        dueAt: v2110ExpectedWorldCupDueAt(),
        startAt: null,
        endAt: null,
      }),
    );
    expect(repairMocks.updateReminderPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: mirror.id,
        itemId: null,
      }),
    );
  });

  it("is idempotent when the World Cup task is already repaired", async () => {
    const item = { ...worldCupItem(), dueAt: v2110ExpectedWorldCupDueAt() };
    repairMocks.listManageableItems.mockResolvedValue([item]);
    const result = await applyV2110ProductionRepair({ userId: "user" });
    expect(result.preview.safeToApply).toBe(true);
    expect(result.updatedItemIds).toEqual([]);
    expect(repairMocks.updatePlannerItemSchedule).not.toHaveBeenCalled();
  });
});

function worldCupItem(): PlannerItem {
  return {
    id: "world-cup-item",
    userId: "user",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Сделать план на длинный обзор событий чемпионата мира",
    description: null,
    location: null,
    timezone,
    startAt: null,
    endAt: null,
    dueAt: new Date("2026-06-15T05:00:00.000Z"),
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "today_focus",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function intendedPolicy(itemId: string): ReminderPolicy {
  return {
    id: "intended-policy",
    userId: "user",
    itemId,
    title: "Сделать план на длинный обзор событий чемпионата мира",
    category: "today_focus",
    policyType: "nag_until_ack",
    status: "active",
    timezone,
    startsAt: new Date("2026-06-14T17:00:00.000Z"),
    endsAt: new Date("2026-06-14T20:59:00.000Z"),
    nextFireAt: new Date("2026-06-14T17:00:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: 30,
    requireAck: true,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "keep_open",
    snoozedUntil: null,
    snoozeScope: null,
    quietHours: null,
    escalationPolicy: null,
    metadata: { activeWindowStart: "20:00", activeWindowEnd: "23:59" },
    createdAt: now,
    updatedAt: now,
  };
}

function mirrorPolicy(itemId: string): ReminderPolicy {
  return {
    ...intendedPolicy(itemId),
    id: "mirror-policy",
    title: "Проверить и решить вопрос с зеркалом на машину",
    policyType: "recurring",
    recurrenceRule: "weekly:MO@10:00",
  };
}

function staleSession(itemId: string): AgentAction {
  return {
    id: "stale-session",
    userId: "user",
    sourceMessageId: null,
    actionType: "item_edit_session",
    status: "pending",
    input: { itemId },
    output: { itemId },
    undoPayload: {},
    createdAt: now,
    updatedAt: now,
  };
}
