import { describe, expect, it, vi } from "vitest";

import {
  buildReleaseNotificationText,
  hasMojibakeSignal,
  notifyProductionRelease,
  type ReleaseInspection,
  type ReleaseNotificationDependencies,
  type ReleaseNotificationStore,
} from "@/services/releaseNotification";
import { RELEASE_NOTES } from "@/lib/releaseMetadata";
import { parseBeforeEventReminderSpecsForAnchor } from "@/domain/beforeEventReminderParsing";
import type { AgentAction, PlannerItem, ReleaseNotification, ReminderPolicy } from "@/db/schema";
import { formatDashboardItem } from "@/telegram/liveDashboard";
import {
  formatItemReminderPolicyLines,
  isReminderPolicyReviewRequired,
} from "@/domain/reminderPolicyPresentation";
import {
  ambiguousEventCandidateForItem,
  type ProposedEvent,
} from "@/services/eventTargetResolution";
import { collectV2180ProductionRepairCandidates } from "@/services/v2180ProductionRepair";

const timezone = "Europe/Moscow";
const userId = "22222222-2222-4222-8222-222222222222";
const itemId = "11111111-1111-4111-8111-111111111111";

describe("current release notification and reminder setup", () => {
  it("release_notification_renders_cyrillic_without_mojibake", () => {
    const text = buildReleaseNotificationText({
      version: RELEASE_NOTES.version,
      commitSha: "abcdef1234567890",
      summary: [...RELEASE_NOTES.bullets],
      tests: ["migrations:not_required", "smoke:passed"],
      inspection: healthyInspection(),
    });

    expect(text).toContain("сделал /plan компактнее");
    expect(text).toContain("скрыл фоновые post-event follow-up policies");
    expect(text).toContain("починил daily recurring без времени");
    expect(text).toContain("укоротил опасные Telegram callback payloads");
    expect(text).toContain("обновлён до V2.20.0");
    expect(text).not.toContain("????");
    expect(text).not.toContain("пїЅ");
    expect(hasMojibakeSignal(text)).toBe(false);
  });

  it("falls back to server-side release notes when provided summary is mojibake", async () => {
    const harness = releaseHarness();
    await notifyProductionRelease(
      {
        version: RELEASE_NOTES.version,
        commitSha: "abcdef1234567890",
        summary: ["??????? ???????"],
        tests: ["migrations:not_required", "smoke:passed"],
        handoffUpdated: true,
      },
      harness.dependencies,
    );

    const sentText = harness.send.mock.calls[0]?.[0].text ?? "";
    expect(sentText).toContain("сделал /plan компактнее");
    expect(sentText).not.toContain("????");
  });

  it.each([
    ["за 2 часа, за час и за полчаса", [120, 60, 30]],
    ["за два часа и за полчаса", [120, 30]],
    ["за 2 часа, за 1 час, за 30 минут", [120, 60, 30]],
    ["за 3 часа, за 2 часа, за час", [180, 120, 60]],
    ["за день в 9 утра, за 2 часа и за 30 минут", [1440 + 390, 120, 30]],
    ["в 7.00 и 7.30", [510, 480]],
    ["в 7:00, 7:30", [510, 480]],
  ])("parses deterministic reminder setup phrase: %s", (text, expectedMinutes) => {
    const result = parseBeforeEventReminderSpecsForAnchor({
      text,
      anchor: new Date("2026-06-17T12:30:00.000Z"),
      timezone,
      now: new Date("2026-06-16T02:00:00.000Z"),
      allowAbsoluteTimes: true,
    });

    expect(result.reminders.map((reminder) => reminder.minutesBefore)).toEqual(expectedMinutes);
    expect(result.pastLabels).toEqual([]);
  });

  it("renders event reminders without generic one-time noise", () => {
    const item = plannerItem({
      title: "Созвон с Винлайном по ЧМ",
      startAt: new Date("2026-06-17T12:30:00.000Z"),
      endAt: new Date("2026-06-17T13:30:00.000Z"),
    });
    const brokenPolicy = reminderPolicy({
      itemId: item.id,
      policyType: "one_time",
      startsAt: null,
      nextFireAt: null,
    });
    const policies = [
      reminderPolicy({ itemId: item.id, metadata: { minutesBefore: 120 } }),
      reminderPolicy({ itemId: item.id, metadata: { minutesBefore: 120 } }),
      reminderPolicy({
        itemId: item.id,
        policyType: "one_time",
        startsAt: new Date("2026-06-17T12:00:00.000Z"),
        nextFireAt: new Date("2026-06-17T12:00:00.000Z"),
      }),
      brokenPolicy,
    ];

    const lines = formatItemReminderPolicyLines(policies, timezone, {
      item,
      now: new Date("2026-06-16T12:00:00.000Z"),
    });
    const dashboard = formatDashboardItem(item, timezone, null, true, policies);

    expect(lines).toContain("за 2 часа");
    expect(lines).toContain("за 30 минут");
    expect(lines.join("\n")).not.toContain("требует проверки");
    expect(lines.join("\n")).not.toContain("один раз");
    expect(dashboard.match(/за 2 часа/g)?.length).toBe(1);
    expect(dashboard).not.toContain("один раз");
    expect(isReminderPolicyReviewRequired(brokenPolicy, item)).toBe(true);
  });

  it("renders post-event follow-up policies without broken-policy noise", () => {
    const item = plannerItem({
      title: "Созвон с Винлайном по ЧМ",
      startAt: new Date("2026-06-17T12:30:00.000Z"),
      endAt: new Date("2026-06-17T13:30:00.000Z"),
    });
    const policy = reminderPolicy({
      itemId: item.id,
      policyType: "post_event_menu",
      category: "post_event",
      startsAt: new Date("2026-06-17T14:00:00.000Z"),
      nextFireAt: new Date("2026-06-17T14:00:00.000Z"),
    });

    const lines = formatItemReminderPolicyLines([policy], timezone, {
      item,
      now: new Date("2026-06-16T12:00:00.000Z"),
    });

    expect(lines.join("\n")).toContain("после события");
    expect(lines.join("\n")).not.toContain("требует проверки");
    expect(isReminderPolicyReviewRequired(policy, item)).toBe(false);
  });

  it("similar_winline_cp_chm_same_time_asks_disambiguation", () => {
    const item = plannerItem({
      title: "Созвон с Винлайном по ЧМ",
      startAt: new Date("2026-06-17T12:30:00.000Z"),
      endAt: new Date("2026-06-17T13:30:00.000Z"),
    });
    const proposed: ProposedEvent = {
      title: "Созвон с Винлайном по ЦП",
      kind: "event",
      startAtLocal: "2026-06-17T15:30:00",
      endAtLocal: "2026-06-17T16:30:00",
      timezone,
      durationMinutes: 60,
      reminderMode: "add",
      reminders: [
        { fireAtLocal: "2026-06-17T13:30:00", minutesBefore: 120, label: "за 2 часа" },
        { fireAtLocal: "2026-06-17T15:00:00", minutesBefore: 30, label: "за 30 минут" },
      ],
    };

    const candidate = ambiguousEventCandidateForItem({
      item,
      proposedEvent: proposed,
      proposedStart: new Date("2026-06-17T12:30:00.000Z"),
      proposedEnd: new Date("2026-06-17T13:30:00.000Z"),
    });

    expect(candidate).toEqual(
      expect.objectContaining({
        itemId: item.id,
        conflictType: "same_entity_different_title",
      }),
    );
    expect(candidate?.matchedEntities).toContain("винлайном");
  });

  it("v2180 repair preview counts unsafe local-only candidates", () => {
    const now = new Date("2026-06-16T15:30:00.000Z");
    const event = plannerItem({
      id: itemId,
      title: "Созвон с Винлайном по ЧМ",
      startAt: new Date("2026-06-17T12:30:00.000Z"),
    });
    const past = plannerItem({
      id: "33333333-3333-4333-8333-333333333333",
      title: "Студия Central Park",
      priority: 5,
      startAt: new Date("2026-06-16T07:00:00.000Z"),
      endAt: new Date("2026-06-16T08:00:00.000Z"),
      metadata: { important: true },
    });
    const fake = plannerItem({
      id: "44444444-4444-4444-8444-444444444444",
      kind: "task",
      title: "Напоминание за 2 часа",
    });
    const candidates = collectV2180ProductionRepairCandidates({
      items: [event, past, fake],
      policies: [
        reminderPolicy({ id: "p1", itemId: event.id, metadata: { minutesBefore: 120 } }),
        reminderPolicy({ id: "p2", itemId: event.id, metadata: { minutesBefore: 120 } }),
        reminderPolicy({
          id: "p3",
          itemId: event.id,
          startsAt: null,
          nextFireAt: null,
          metadata: {},
        }),
      ],
      sessions: [
        agentAction({
          id: "a1",
          actionType: "multi_reminder_setup_session",
          output: {
            itemId: event.id,
            expiresAt: "2026-06-16T12:00:00.000Z",
          },
        }),
      ],
      now,
    });

    expect(candidates.calendarObjectsToChange).toBe(0);
    expect(candidates.duplicateBeforeEventPolicyIds).toEqual(["p2"]);
    expect(candidates.genericBeforeEventPolicyIds).toEqual(["p3"]);
    expect(candidates.pastImportantEventIds).toEqual([past.id]);
    expect(candidates.staleReminderSessionActionIds).toEqual(["a1"]);
    expect(candidates.fakeReminderItemIds).toEqual([fake.id]);
  });
});

function healthyInspection(): ReleaseInspection {
  return {
    healthOk: true,
    version: RELEASE_NOTES.version,
    commitSha: "abcdef1234567890",
    webhookOk: true,
    runnerOk: true,
    schedulerConfigured: true,
    lastRunnerRunAt: "2026-06-16T12:00:00.000Z",
    warnings: [],
  };
}

function releaseHarness() {
  const records: ReleaseNotification[] = [];
  const send = vi.fn(async () => ({ messageId: 101n }));
  const store: ReleaseNotificationStore = {
    async getLatest() {
      return records.at(-1) ?? null;
    },
    async getLatestSentForVersion() {
      return null;
    },
    async reserve(params) {
      const notification = releaseRecord({
        version: params.key.version,
        commitSha: params.key.commitSha,
        environment: params.key.environment,
        summary: params.summary,
      });
      records.push(notification);
      return { state: "reserved" as const, notification };
    },
    async markSent(params) {
      const record = records.find((candidate) => candidate.id === params.id)!;
      record.status = "sent";
      record.telegramMessageId = params.telegramMessageId;
      record.summary = params.summary;
      record.sentAt = new Date();
      return record;
    },
    async markFailed(params) {
      const record = records.find((candidate) => candidate.id === params.id)!;
      record.status = "failed";
      record.lastError = params.error;
      return record;
    },
  };
  const dependencies: ReleaseNotificationDependencies = {
    store,
    inspect: async () => healthyInspection(),
    send,
  };
  process.env.ALLOWED_TELEGRAM_USER_IDS = "42";
  return { dependencies, send };
}

function plannerItem(overrides: Partial<PlannerItem> = {}): PlannerItem {
  return {
    id: itemId,
    userId,
    pendingActionId: null,
    kind: "event",
    status: "active",
    title: "Созвон",
    description: null,
    location: null,
    timezone,
    startAt: new Date("2026-06-17T12:30:00.000Z"),
    endAt: new Date("2026-06-17T13:30:00.000Z"),
    dueAt: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    category: "event",
    visibility: "active",
    sourcePolicyId: null,
    snoozedUntil: null,
    priority: 3,
    source: "telegram",
    metadata: {},
    createdAt: new Date("2026-06-16T10:00:00.000Z"),
    updatedAt: new Date("2026-06-16T10:00:00.000Z"),
    ...overrides,
  };
}

function reminderPolicy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return {
    id: crypto.randomUUID(),
    userId,
    itemId,
    title: "Созвон",
    category: "pre_event",
    policyType: "before_event",
    status: "active",
    timezone,
    startsAt: new Date("2026-06-17T10:30:00.000Z"),
    endsAt: null,
    nextFireAt: new Date("2026-06-17T10:30:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: null,
    requireAck: false,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    snoozedUntil: null,
    snoozeScope: null,
    quietHours: null,
    escalationPolicy: null,
    metadata: {},
    createdAt: new Date("2026-06-16T10:00:00.000Z"),
    updatedAt: new Date("2026-06-16T10:00:00.000Z"),
    ...overrides,
  };
}

function agentAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: crypto.randomUUID(),
    userId,
    sourceMessageId: null,
    actionType: "multi_reminder_setup_session",
    status: "pending",
    input: {},
    output: {},
    undoPayload: {},
    createdAt: new Date("2026-06-16T10:00:00.000Z"),
    ...overrides,
  };
}

function releaseRecord(overrides: Partial<ReleaseNotification> = {}): ReleaseNotification {
  const now = new Date("2026-06-16T12:00:00.000Z");
  return {
    id: crypto.randomUUID(),
    version: RELEASE_NOTES.version,
    commitSha: "abcdef1234567890",
    environment: "production",
    status: "pending",
    sentAt: null,
    telegramMessageId: null,
    summary: {},
    lastError: null,
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
