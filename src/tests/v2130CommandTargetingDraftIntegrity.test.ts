import { beforeEach, describe, expect, it, vi } from "vitest";

const repairMocks = vi.hoisted(() => ({
  listManageableItems: vi.fn(),
  cancelPlannerItemWithMetadata: vi.fn(),
  updatePlannerItemDetails: vi.fn(),
  listActiveReminderPolicies: vi.fn(),
  createReminderPolicyIfMissing: vi.fn(),
  listReminderPoliciesForItem: vi.fn(),
  updateReminderPolicy: vi.fn(),
  cancelPendingRemindersForPolicy: vi.fn(),
  listPendingAgentActionsByTypes: vi.fn(),
  updateAgentAction: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/db/queries/items", () => ({
  listManageableItems: repairMocks.listManageableItems,
  cancelPlannerItemWithMetadata: repairMocks.cancelPlannerItemWithMetadata,
  updatePlannerItemDetails: repairMocks.updatePlannerItemDetails,
}));
vi.mock("@/db/queries/reminderPolicies", () => ({
  listActiveReminderPolicies: repairMocks.listActiveReminderPolicies,
  createReminderPolicyIfMissing: repairMocks.createReminderPolicyIfMissing,
  listReminderPoliciesForItem: repairMocks.listReminderPoliciesForItem,
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

import type { ActionPlan } from "@/ai/schemas";
import type { AgentReminderPolicy } from "@/ai/schemas/agentExecution";
import type { AgentAction, PlannerItem, ReminderPolicy } from "@/db/schema";
import { parseItemEditMutation } from "@/services/itemEditMutations";
import {
  buildRecurringPolicyDraftFingerprint,
  getIncompleteRecurringPolicies,
} from "@/services/recurringPolicyDraftSessions";
import {
  applyV2130ProductionRepair,
  previewV2130ProductionRepair,
} from "@/services/v2130ProductionRepair";
import { sanitizeForActionLog } from "@/services/actionLog";

const timezone = "Europe/Moscow";
const now = new Date("2026-06-15T09:00:00.000Z");

describe("V2.13.0 command targeting, draft integrity and actionlog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repairMocks.listManageableItems.mockResolvedValue([]);
    repairMocks.listActiveReminderPolicies.mockResolvedValue([]);
    repairMocks.listPendingAgentActionsByTypes.mockResolvedValue([]);
    repairMocks.cancelPlannerItemWithMetadata.mockImplementation((params) =>
      Promise.resolve({ id: params.itemId, ...params }),
    );
    repairMocks.updatePlannerItemDetails.mockImplementation((params) =>
      Promise.resolve({ id: params.itemId, ...params }),
    );
    repairMocks.updateReminderPolicy.mockImplementation((params) =>
      Promise.resolve({ id: params.policyId, ...params }),
    );
    repairMocks.updateAgentAction.mockImplementation((params) =>
      Promise.resolve({ id: params.actionId, ...params }),
    );
    repairMocks.writeAudit.mockResolvedValue(undefined);
  });

  it("turns 'today all day' inside item edit into an explicit all-day event", () => {
    const mutation = parseItemEditMutation({
      text: "Сегодня целый день",
      item: plannerItem({
        kind: "task",
        title: "Ортодонт Роб",
        startAt: new Date("2026-06-15T06:00:00.000Z"),
        endAt: new Date("2026-06-15T07:00:00.000Z"),
      }),
      timezone,
      now,
    });

    expect(mutation).toEqual(
      expect.objectContaining({
        kind: "event",
        allDay: true,
        scheduledForLocal: "2026-06-15T00:00:00+03:00",
        endsAtLocal: "2026-06-15T23:59:59+03:00",
      }),
    );
    expect(mutation.changedFields).toEqual(expect.arrayContaining(["kind", "schedule"]));
  });

  it("detects incomplete recurring policies and fingerprints duplicate drafts", () => {
    const policy = recurringMeterPolicyProposal();
    expect(getIncompleteRecurringPolicies([policy])).toEqual([policy]);
    const first = buildRecurringPolicyDraftFingerprint({
      plan: recurringDraftPlan(),
      policies: [policy],
    });
    const second = buildRecurringPolicyDraftFingerprint({
      plan: recurringDraftPlan(),
      policies: [{ ...policy, title: "  внести   показания счетчиков за квартиру " }],
    });

    expect(first).toBe(second);
  });

  it("previews and applies production repair without touching Yandex calendar objects", async () => {
    const meterItem = plannerItem({
      id: "meter-item",
      kind: "recurring_task",
      title: "Внести показания счетчиков за квартиру",
      startAt: null,
      endAt: null,
      dueAt: null,
      metadata: { timeUnspecified: true },
    });
    const orthodontist = plannerItem({
      id: "orthodontist-item",
      kind: "task",
      title: "Ортодонт Роб",
      startAt: new Date("2026-06-16T05:00:00.000Z"),
      endAt: new Date("2026-06-16T06:00:00.000Z"),
    });
    const meterPolicy = reminderPolicy({
      id: "meter-policy",
      itemId: meterItem.id,
      title: meterItem.title,
      policyType: "recurring",
      recurrenceRule: "monthly_days:15,16,17,18,19",
      nextFireAt: null,
    });
    const orphanOrthodontist = reminderPolicy({
      id: "ortho-policy",
      itemId: null,
      title: "Ортодонт Роб",
      policyType: "before_event",
      recurrenceRule: null,
      nextFireAt: new Date("2026-06-16T04:00:00.000Z"),
    });
    const newestDraft = agentAction({
      id: "draft-new",
      actionType: "recurring_policy_draft",
      output: { draftFingerprint: "meter" },
      createdAt: new Date("2026-06-15T08:00:00.000Z"),
    });
    const duplicateDraft = agentAction({
      id: "draft-old",
      actionType: "recurring_policy_draft",
      output: { draftFingerprint: "meter" },
      createdAt: new Date("2026-06-15T07:00:00.000Z"),
    });
    const staleEdit = agentAction({ id: "edit-session", actionType: "item_edit_session" });

    repairMocks.listManageableItems.mockResolvedValue([meterItem, orthodontist]);
    repairMocks.listActiveReminderPolicies.mockResolvedValue([meterPolicy, orphanOrthodontist]);
    repairMocks.listPendingAgentActionsByTypes.mockResolvedValue([
      newestDraft,
      duplicateDraft,
      staleEdit,
    ]);

    const preview = await previewV2130ProductionRepair({ userId: "user", now });
    expect(preview).toEqual(
      expect.objectContaining({
        incompleteMeterItemIds: [meterItem.id],
        incompleteMeterPolicyIds: [meterPolicy.id],
        duplicateRecurringDraftIds: [duplicateDraft.id],
        staleSessionIds: [newestDraft.id, duplicateDraft.id, staleEdit.id],
        orthodontistItemId: orthodontist.id,
        orthodontistNeedsEventKind: true,
        orphanOrthodontistPolicyIds: [orphanOrthodontist.id],
        calendarObjectsToChange: 0,
      }),
    );

    const result = await applyV2130ProductionRepair({ userId: "user", now });
    expect(result.archivedItemIds).toEqual([meterItem.id]);
    expect(result.cancelledPolicyIds).toEqual([meterPolicy.id]);
    expect(result.clearedSessionIds).toEqual([newestDraft.id, duplicateDraft.id, staleEdit.id]);
    expect(result.normalizedItemIds).toEqual([orthodontist.id]);
    expect(result.retargetedPolicyIds).toEqual([orphanOrthodontist.id]);
    expect(result.calendarObjectsChanged).toBe(0);
    expect(repairMocks.cancelPendingRemindersForPolicy).toHaveBeenCalledWith({
      userId: "user",
      policyId: meterPolicy.id,
    });
  });

  it("redacts secrets from action log diagnostics", () => {
    expect(
      sanitizeForActionLog({
        OPENAI_API_KEY: "sk-fake-test-secret",
        nested: {
          databaseUrl: "postgresql://user:pass@example/db",
          Authorization: "Bearer abc",
          safe: "visible",
        },
      }),
    ).toEqual({
      OPENAI_API_KEY: "[redacted]",
      nested: {
        databaseUrl: "[redacted]",
        Authorization: "[redacted]",
        safe: "visible",
      },
    });
  });
});

function recurringDraftPlan(): ActionPlan {
  return {
    intent: "plan",
    summary: null,
    reply: null,
    confidence: 0.9,
    requiresConfirmation: true,
    memoryCandidates: [],
    clarificationQuestions: [],
    actions: [
      {
        actionType: "recurring_task",
        kind: "recurring_task",
        title: "Внести показания счетчиков за квартиру",
        description: null,
        location: null,
        timezone,
        startAtLocal: null,
        endAtLocal: null,
        dueAtLocal: null,
        durationMinutes: null,
        priority: 3,
        confidence: 0.85,
        risk: "medium",
        requiresConfirmation: true,
        tentative: false,
        recurrence: null,
        reminders: [],
        memoryCandidates: [],
        metadata: {
          timeUnspecified: true,
          recurrenceRule: "monthly_days:15,16,17,18,19",
        },
      },
    ],
  };
}

function recurringMeterPolicyProposal(): AgentReminderPolicy {
  return {
    operation: "create_recurring_policy",
    itemIds: [],
    itemTitle: "Внести показания счетчиков за квартиру",
    title: "Внести показания счетчиков за квартиру",
    category: "recurring_home",
    policyType: "recurring",
    startsAtLocal: null,
    endsAtLocal: null,
    nextFireAtLocal: null,
    recurrenceRule: "monthly_days:15,16,17,18,19",
    intervalMinutes: 60,
    requireAck: true,
    maxOccurrences: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "keep_open",
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
  };
}

function plannerItem(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: "item",
    userId: "user",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: "Task",
    description: null,
    location: null,
    timezone,
    startAt: null,
    endAt: null,
    dueAt: null,
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
    ...overrides,
  };
}

function reminderPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: "policy",
    userId: "user",
    itemId: null,
    title: "Policy",
    category: "recurring_home",
    policyType: "recurring",
    status: "active",
    timezone,
    startsAt: null,
    endsAt: null,
    nextFireAt: null,
    recurrenceRule: null,
    intervalMinutes: 60,
    requireAck: true,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "keep_open",
    snoozedUntil: null,
    snoozeScope: null,
    quietHours: null,
    escalationPolicy: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function agentAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: "action",
    userId: "user",
    sourceMessageId: null,
    actionType: "item_edit_session",
    status: "pending",
    input: {},
    output: {},
    undoPayload: {},
    createdAt: now,
    ...overrides,
  };
}
