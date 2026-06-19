import { randomUUID } from "node:crypto";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import { agentExecutionSchema, type AgentReminderPolicy } from "@/ai/schemas/agentExecution";
import { writeAudit } from "@/db/queries/audit";
import { detectOpenEndedUntilDoneIntent } from "@/domain/openEndedUntilDoneIntent";
import { formatActionPlanCard } from "@/bot/formatters";

const OWNER_PHRASE =
  "Напоминай мне починить кран в ванной до тех пор, когда не сделаю, каждый час";

export async function runV2270UntilDonePhraseOrderSmoke(params: {
  userId: string;
  timezone: string;
}) {
  const now = new Date("2026-06-19T17:00:00.000Z");
  const detected = detectOpenEndedUntilDoneIntent({
    text: OWNER_PHRASE,
    timezone: params.timezone,
    now,
  });
  const execution = normalizeAgentExecutionProposal({
    execution: badAiExecution(),
    text: OWNER_PHRASE,
    timezone: params.timezone,
    now,
    activeContext: "none",
  });
  const preview = execution.actionPlan
    ? formatActionPlanCard(execution.actionPlan, params.timezone)
    : "";
  const policy = execution.reminderPolicies[0] ?? null;
  const result = {
    ok:
      detected?.title === "Починить кран в ванной" &&
      detected.intervalMinutes === 60 &&
      detected.sourceOrder === "title_before_stop_condition" &&
      execution.actionPlan?.actions.length === 1 &&
      execution.actionPlan.actions[0]?.title === "Починить кран в ванной" &&
      policy?.policyType === "nag_until_ack" &&
      policy.intervalMinutes === 60 &&
      policy.endsAtLocal === null &&
      Boolean(policy.nextFireAtLocal) &&
      !preview.includes("без времени") &&
      !preview.includes("missing_initial_fire"),
    detected,
    policyType: policy?.policyType ?? null,
    intervalMinutes: policy?.intervalMinutes ?? null,
    nextFireAtLocal: policy?.nextFireAtLocal ?? null,
    previewHasWithoutTime: preview.includes("без времени"),
  };
  await writeSmokeAudit(params.userId, "assistant.v2270_until_done_phrase_order_smoke", result);
  return result;
}

export async function runV2270UntilDoneAiNormalizationSmoke(params: {
  userId: string;
  timezone: string;
}) {
  const now = new Date("2026-06-19T17:00:00.000Z");
  const execution = normalizeAgentExecutionProposal({
    execution: agentExecutionSchema.parse({
      ...emptyExecution(),
      intent: "create_plan",
      actionPlan: {
        intent: "plan",
        summary: "Починить кран в ванной",
        reply: null,
        confidence: 0.88,
        requiresConfirmation: true,
        actions: [
          {
            actionType: "task",
            kind: "task",
            title: "Починить кран в ванной",
            description: null,
            location: null,
            timezone: params.timezone,
            startAtLocal: null,
            endAtLocal: null,
            dueAtLocal: null,
            durationMinutes: null,
            priority: 3,
            confidence: 0.88,
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
          itemTitle: "Напоминание о ремонте крана в ванной",
          title: "Напоминание о ремонте крана в ванной",
          intervalMinutes: 60,
          requireAck: true,
        }),
      ],
    }),
    text: OWNER_PHRASE,
    timezone: params.timezone,
    now,
    activeContext: "none",
  });
  const action = execution.actionPlan?.actions[0] ?? null;
  const normalizedPolicy = execution.reminderPolicies[0] ?? null;
  const result = {
    ok:
      execution.intent === "create_plan" &&
      execution.actionPlan?.requiresConfirmation === false &&
      action?.title === "Починить кран в ванной" &&
      action.metadata?.untilDoneAiProposalNormalized === true &&
      normalizedPolicy?.policyType === "nag_until_ack" &&
      normalizedPolicy.requireAck === true &&
      normalizedPolicy.startsAtLocal === "2026-06-19T20:05:00" &&
      normalizedPolicy.nextFireAtLocal === "2026-06-19T20:05:00" &&
      normalizedPolicy.endsAtLocal === null,
    actionTitle: action?.title ?? null,
    policyType: normalizedPolicy?.policyType ?? null,
    originalPolicyType: action?.metadata?.originalPolicyType ?? null,
    startsAtLocal: normalizedPolicy?.startsAtLocal ?? null,
    nextFireAtLocal: normalizedPolicy?.nextFireAtLocal ?? null,
  };
  await writeSmokeAudit(params.userId, "assistant.v2270_until_done_ai_normalization_smoke", result);
  return result;
}

function badAiExecution() {
  return agentExecutionSchema.parse({
    ...emptyExecution(),
    intent: "manage_reminder_policies",
    reminderPolicies: [
      policy({
        operation: "create_recurring_policy",
        policyType: "recurring",
        itemTitle: "Починить кран в ванной",
        title: "Починить кран в ванной",
        recurrenceRule: null,
        startsAtLocal: null,
        nextFireAtLocal: null,
        intervalMinutes: 60,
        requireAck: true,
      }),
    ],
  });
}

function emptyExecution() {
  return {
    intent: "clarify" as const,
    reply: null,
    actionPlan: null,
    viewScope: null,
    resetMode: null,
    itemUpdates: [],
    reminderPolicies: [],
    memoryFacts: [],
    clarificationQuestions: [],
  };
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

async function writeSmokeAudit(
  userId: string,
  action: string,
  details: Record<string, unknown>,
) {
  await writeAudit({
    userId,
    action,
    entityType: "planner_item",
    entityId: randomUUID(),
    details,
  }).catch(() => undefined);
}
