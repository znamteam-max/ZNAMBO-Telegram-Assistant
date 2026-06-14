import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listManageableItems: vi.fn(),
  updatePlannerItemDetails: vi.fn(),
  getItemCalendarSyncState: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/db/queries/items", () => ({
  listManageableItems: mocks.listManageableItems,
  updatePlannerItemDetails: mocks.updatePlannerItemDetails,
}));
vi.mock("@/db/queries/googleCalendar", () => ({
  getItemCalendarSyncState: mocks.getItemCalendarSyncState,
}));
vi.mock("@/db/queries/audit", () => ({
  writeAudit: mocks.writeAudit,
}));

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { agentExecutionSchema } from "@/ai/schemas/agentExecution";
import { postCreateTriageKeyboard } from "@/bot/keyboards";
import { formatCommittedPlanSummary } from "@/bot/formatters";
import type { PlannerItem } from "@/db/schema";
import {
  buildDeadlineReminderFireAt,
  formatDeadlineDateTime,
  parseDeadlineSemantics,
} from "@/domain/deadlineSemantics";
import { parseItemEditMutation } from "@/services/itemEditMutations";
import {
  applyV290ProductionRepair,
  isV290MisparsedDeadlineItem,
  previewV290ProductionRepair,
} from "@/services/v290ProductionRepair";
import { buildUserTimelineViewFromData } from "@/services/userTimeline";
import { formatItemTimingLines } from "@/telegram/entityCards";
import { formatDashboardItem } from "@/telegram/liveDashboard";

const timezone = "Europe/Moscow";
const now = new Date("2026-06-14T09:24:00.000Z");

describe("V2.9.0 deadline semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getItemCalendarSyncState.mockResolvedValue(null);
    mocks.writeAudit.mockResolvedValue(undefined);
  });

  it("turns the production phrase into a deadline-only task for tomorrow", () => {
    const execution = normalizeAgentExecutionProposal({
      execution: emptyExecution(),
      text: 'Сделать цитаты "норм / стрём" для эфира больше, дедлайн завтра до 14.00',
      timezone,
      now,
      activeContext: "none",
    });
    const action = execution.actionPlan?.actions[0];

    expect(action).toEqual(
      expect.objectContaining({
        kind: "task",
        title: 'Сделать цитаты "норм / стрём" для эфира Больше',
        startAtLocal: null,
        endAtLocal: null,
        dueAtLocal: "2026-06-15T14:00:00",
      }),
    );
    expect(action?.metadata).toEqual(
      expect.objectContaining({ hasDeadline: true, deadlineOnly: true }),
    );
  });

  it.each([
    ["Сдать текст завтра до 12", "2026-06-15 12:00"],
    ["Позвонить завтра до 14", "2026-06-15 14:00"],
    ["Сделать презентацию до пятницы 18:00", "2026-06-19 18:00"],
    ["Дедлайн в пятницу до 18:00", "2026-06-19 18:00"],
  ])("parses %s as a due task", (text, expected) => {
    const parsed = parseDeadlineSemantics({ text, timezone, now });
    expect(parsed?.dueLocal.toFormat("yyyy-MM-dd HH:mm")).toBe(expected);
    expect(parsed?.scheduledStartLocal).toBeNull();
    expect(parsed?.scheduledEndLocal).toBeNull();
  });

  it("keeps an explicit work block separate from the deadline", () => {
    const parsed = parseDeadlineSemantics({
      text: "Завтра с 10 до 12 сделать текст, дедлайн до 18",
      timezone,
      now,
    });
    expect(parsed?.scheduledStartLocal?.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-06-15 10:00");
    expect(parsed?.scheduledEndLocal?.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-06-15 12:00");
    expect(parsed?.dueLocal.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-06-15 18:00");
  });

  it("does not treat an ordinary time range as a deadline", () => {
    expect(
      parseDeadlineSemantics({
        text: "Завтра с 19.00 до 20.00 эфир",
        timezone,
        now,
      }),
    ).toBeNull();
  });

  it("renders a deadline with до and never as an ongoing range", () => {
    const item = makeDeadlineItem();
    const timeline = buildUserTimelineViewFromData({
      items: [item],
      policies: [],
      timezone,
      now,
    });
    expect(timeline.rows[0]).toEqual(
      expect.objectContaining({ dateBucket: "tomorrow", classification: "soon" }),
    );

    const text = formatDashboardItem(item, timezone, null, true, [], now);
    expect(text).toContain("Пн, 15.06 до 14:00");
    expect(text).not.toContain("12:00–14:00");
    expect(text).not.toContain("🔴");

    const summary = formatCommittedPlanSummary({
      items: [item],
      reminderCount: 0,
      timezone,
    });
    expect(summary).toContain("дедлайн Пн, 15.06 до 14:00");
    expect(summary).toContain("Напомнить?");
  });

  it("renders deadline and scheduled time as separate task-card fields", () => {
    expect(formatItemTimingLines(makeDeadlineItem())).toEqual([
      "Запланированное время: нет",
      "Дедлайн: Пн, 15.06.2026 до 14:00",
    ]);

    expect(
      formatItemTimingLines({
        ...makeDeadlineItem(),
        startAt: new Date("2026-06-15T07:00:00.000Z"),
        endAt: new Date("2026-06-15T09:00:00.000Z"),
      }),
    ).toEqual([
      "Когда делать: Пн, 15.06.2026 10:00–12:00",
      "Дедлайн: Пн, 15.06.2026 до 14:00",
    ]);
  });

  it("offers deadline reminder presets and calculates their fire times", () => {
    const labels = postCreateTriageKeyboard([makeDeadlineItem()], now).inline_keyboard
      .flat()
      .map((button) => button.text);
    expect(labels).toEqual(
      expect.arrayContaining(["Утром", "За 2 часа", "За 30 минут", "Не надо", "Настроить"]),
    );
    expect(
      buildDeadlineReminderFireAt({
        dueAt: new Date("2026-06-15T11:00:00.000Z"),
        timezone,
        preset: "morning",
        now,
      }),
    ).toEqual(new Date("2026-06-15T06:00:00.000Z"));
    expect(
      buildDeadlineReminderFireAt({
        dueAt: new Date("2026-06-15T11:00:00.000Z"),
        timezone,
        preset: "2h",
        now,
      }),
    ).toEqual(new Date("2026-06-15T09:00:00.000Z"));

    const todayItem = {
      ...makeDeadlineItem(),
      dueAt: new Date("2026-06-14T15:00:00.000Z"),
    };
    const todayLabels = postCreateTriageKeyboard([todayItem], now).inline_keyboard
      .flat()
      .map((button) => button.text);
    expect(todayLabels).toEqual(
      expect.arrayContaining(["Скоро", "За час", "За 30 минут", "Не надо", "Настроить"]),
    );
    expect(
      buildDeadlineReminderFireAt({
        dueAt: todayItem.dueAt,
        timezone,
        preset: "soon",
        now,
      }),
    ).toEqual(new Date("2026-06-14T09:34:00.000Z"));
    expect(
      buildDeadlineReminderFireAt({
        dueAt: todayItem.dueAt,
        timezone,
        preset: "1h",
        now,
      }),
    ).toEqual(new Date("2026-06-14T14:00:00.000Z"));
  });

  it("edits and clears a deadline inside the current item context", () => {
    const item = { ...makeDeadlineItem(), dueAt: null };
    const set = parseItemEditMutation({
      text: "Поставь дедлайн на завтра до 14",
      item,
      timezone,
      now,
    });
    expect(set.deadlineAtLocal).toBe("2026-06-15T14:00:00+03:00");
    expect(set.changedFields).toEqual(["deadline"]);

    const clear = parseItemEditMutation({
      text: "Убери дедлайн",
      item: makeDeadlineItem(),
      timezone,
      now,
    });
    expect(clear.clearDeadline).toBe(true);
    expect(clear.changedFields).toEqual(["deadline"]);
  });

  it("shows both work time and deadline in a mixed edit preview model", () => {
    const mutation = parseItemEditMutation({
      text: "Запланируй делать завтра с 10 до 12, дедлайн до 14",
      item: { ...makeDeadlineItem(), startAt: null, endAt: null, dueAt: null },
      timezone,
      now,
    });
    expect(mutation.scheduledForLocal).toBe("2026-06-15T10:00:00+03:00");
    expect(mutation.endsAtLocal).toBe("2026-06-15T12:00:00+03:00");
    expect(mutation.deadlineAtLocal).toBe("2026-06-15T14:00:00+03:00");
    expect(mutation.kind).toBeUndefined();
    expect(mutation.changedFields).toEqual(["schedule", "deadline"]);
  });

  it("repairs the exact production item idempotently without calendar deletion", async () => {
    const bad = makeMisparsedItem();
    mocks.listManageableItems.mockResolvedValueOnce([bad]).mockResolvedValueOnce([bad]);
    mocks.updatePlannerItemDetails.mockResolvedValue({
      ...bad,
      kind: "task",
      title: 'Сделать цитаты "норм / стрём" для эфира Больше',
      startAt: null,
      endAt: null,
      dueAt: new Date("2026-06-15T11:00:00.000Z"),
    });

    expect(isV290MisparsedDeadlineItem(bad)).toBe(true);
    const preview = await previewV290ProductionRepair({ userId: "user" });
    expect(preview.deadlineMisparsedTasks).toHaveLength(1);
    expect(preview.safeToApply).toBe(true);

    const applied = await applyV290ProductionRepair({ userId: "user" });
    expect(applied.updatedItemIds).toEqual(["deadline-bad"]);
    expect(applied.calendarObjectsChanged).toBe(0);
    expect(mocks.updatePlannerItemDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "task",
        startAt: null,
        endAt: null,
        dueAt: new Date("2026-06-15T11:00:00.000Z"),
      }),
    );

    mocks.listManageableItems.mockResolvedValue([]);
    expect((await previewV290ProductionRepair({ userId: "user" })).deadlineMisparsedTasks).toHaveLength(0);
  });

  it("formats the canonical deadline text", () => {
    expect(formatDeadlineDateTime(new Date("2026-06-15T11:00:00.000Z"), timezone)).toBe(
      "Пн, 15.06 до 14:00",
    );
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

function makeDeadlineItem(): PlannerItem {
  return {
    id: "deadline",
    userId: "user",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title: 'Сделать цитаты "норм / стрём" для эфира Больше',
    description: null,
    location: null,
    timezone,
    startAt: null,
    endAt: null,
    dueAt: new Date("2026-06-15T11:00:00.000Z"),
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "content",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: { hasDeadline: true, deadlineOnly: true },
    createdAt: now,
    updatedAt: now,
  };
}

function makeMisparsedItem(): PlannerItem {
  return {
    ...makeDeadlineItem(),
    id: "deadline-bad",
    title: "Сделать цитаты 'норм / стрём' для эфира",
    startAt: new Date("2026-06-14T09:00:00.000Z"),
    endAt: new Date("2026-06-14T11:00:00.000Z"),
    dueAt: null,
    metadata: {},
  };
}
