import { NextResponse } from "next/server";

import { getAllowedTelegramUserIds, requireEnv } from "@/lib/env";
import { constantTimeEquals } from "@/lib/secrets";
import { getUserByTelegramId } from "@/db/queries/users";
import {
  cancelPlannerItemWithMetadata,
  createManualPlannerItem,
  getPlannerItemById,
  listManageableItems,
  listVisibleActivePlanItems,
} from "@/db/queries/items";
import { listItemsByIds } from "@/db/queries/taskViewStates";
import {
  cancelItemReminderChains,
  createReminderIfMissing,
  getLatestReminderDelivery,
  getLatestReminderForItem,
} from "@/db/queries/reminders";
import {
  executeActivePlanReset,
  previewActivePlanReset,
} from "@/services/activePlanReset";
import { runOpenAiHealthCheck } from "@/ai/aiHealth";
import {
  MandatoryAiError,
  proposeAgentExecution,
  type AiCallTelemetry,
} from "@/ai/agentExecution";
import { validatePlannerItemsBeforeSave } from "@/ai/antiGarbageValidator";
import { buildJarvisContext } from "@/agent/context/buildJarvisContext";
import { writeAudit } from "@/db/queries/audit";
import { createIdempotencyKey } from "@/lib/idempotency";
import {
  commitStoredActionPlan,
  createStoredActionPlan,
} from "@/services/actionPlanCommit";
import { applyAgentItemUpdates } from "@/services/agentItemUpdates";
import { syncItemsToCalendarBestEffort } from "@/services/calendarBestEffort";
import { filterDuplicateActionPlan } from "@/services/actionPlanDedup";
import { bindContextualCompletionTarget } from "@/services/contextualAgentBinding";
import { applyAgentReminderPolicies } from "@/services/reminderPolicyEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const expected = `Bearer ${requireEnv("CRON_SECRET")}`;
  if (!constantTimeEquals(request.headers.get("authorization"), expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const ownerTelegramId = [...getAllowedTelegramUserIds()][0];
  if (!ownerTelegramId) {
    return NextResponse.json({ ok: false, error: "owner_not_configured" }, { status: 503 });
  }
  const owner = await getUserByTelegramId(ownerTelegramId);
  if (!owner) {
    return NextResponse.json({ ok: false, error: "owner_not_found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    itemId?: string;
    itemIds?: string[];
    text?: string;
    confirm?: boolean;
  };
  if (body.action === "planner_snapshot") {
    const items = await listVisibleActivePlanItems(owner.id, 100);
    return NextResponse.json({
      ok: true,
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        status: item.status,
        startAt: item.startAt?.toISOString() ?? null,
        endAt: item.endAt?.toISOString() ?? null,
        dueAt: item.dueAt?.toISOString() ?? null,
        completedAt: item.completedAt?.toISOString() ?? null,
      })),
    });
  }
  if (
    body.action === "archive_items" &&
    body.confirm === true &&
    Array.isArray(body.itemIds)
  ) {
    const itemIds = [...new Set(body.itemIds)].slice(0, 25);
    const archived = [];
    for (const itemId of itemIds) {
      const item = await cancelPlannerItemWithMetadata({
        userId: owner.id,
        itemId,
        metadata: {
          archivedBy: "protected_admin_repair",
          archivedAt: new Date().toISOString(),
          archiveReason: "confirmed_duplicate_or_incident_record",
        },
      });
      if (item) {
        archived.push({ id: item.id, title: item.title });
        await cancelItemReminderChains(owner.id, [item.id]);
      }
    }
    return NextResponse.json({ ok: true, archived });
  }
  if (body.action === "preview") {
    const result = await previewActivePlanReset({ userId: owner.id, mode: "garbage" });
    return NextResponse.json({
      ok: true,
      action: "preview",
      preview: result.preview,
      titles: result.selectedItems.map((item) => item.title),
    });
  }
  if (body.action === "apply") {
    const result = await executeActivePlanReset({
      userId: owner.id,
      mode: "garbage",
      reason: "one_time_production_repair",
    });
    return NextResponse.json({
      ok: true,
      action: "apply",
      archivedCount: result.items.length,
      titles: result.items.map((item) => item.title),
    });
  }
  if (body.action === "reminder_smoke") {
    const scheduledAt = new Date(Date.now() + 2 * 60 * 1000);
    const item = await createManualPlannerItem({
      userId: owner.id,
      kind: "task",
      title: "Production repair reminder smoke",
      timezone: owner.timezone,
      dueAt: scheduledAt,
      metadata: { isTest: true, source: "remindertest", debug: true },
    });
    await createReminderIfMissing({
      userId: owner.id,
      plannerItemId: item.id,
      type: "custom",
      idempotencyKey: `${item.id}:production-repair-smoke`,
      scheduledAt,
      payload: { title: item.title, isTest: true, source: "remindertest", debug: true },
    });
    return NextResponse.json({
      ok: true,
      action: "reminder_smoke",
      itemId: item.id,
      scheduledAt,
    });
  }
  if (body.action === "smoke_status" && typeof body.itemId === "string") {
    const item = await getPlannerItemById(owner.id, body.itemId);
    const reminder = await getLatestReminderForItem(owner.id, body.itemId);
    const delivery = reminder ? await getLatestReminderDelivery(reminder.id) : null;
    return NextResponse.json({
      ok: true,
      action: "smoke_status",
      itemStatus: item?.status ?? null,
      autoArchivedAfterDelivery: item?.metadata?.autoArchivedAfterDelivery === true,
      reminderStatus: reminder?.status ?? null,
      deliveryStatus: delivery?.status ?? null,
      deliveredAt: delivery?.deliveredAt ?? null,
    });
  }
  if (body.action === "ai_health") {
    const telemetry = await runOpenAiHealthCheck();
    await writeAudit({
      userId: owner.id,
      action: "assistant.ai_health",
      details: {
        ...telemetry,
        pipelineUsed: "production_probe",
        toolCallsExecuted: telemetry.aiSucceeded ? ["report_ai_health"] : [],
        fallbackUsed: false,
        fallbackReason: null,
        finalAction: telemetry.aiSucceeded ? "ai_health_succeeded" : "ai_health_failed",
        createdItemIds: [],
        updatedItemIds: [],
        validationWarnings: [],
      },
    });
    return NextResponse.json({ ok: telemetry.aiSucceeded, telemetry });
  }
  if (body.action === "agent_probe" && typeof body.text === "string") {
    const now = new Date();
    const context = await buildJarvisContext({
      userId: owner.id,
      timezone: owner.timezone,
      query: body.text,
      now,
    });
    let proposed;
    try {
      proposed = await proposeAgentExecution({
        text: body.text,
        timezone: owner.timezone,
        now,
        activeContext: context.activeContext,
      });
    } catch (error) {
      if (!(error instanceof MandatoryAiError)) throw error;
      await writeAudit({
        userId: owner.id,
        action: "assistant.agent_decision_trace",
        details: {
          ...error.telemetry,
          pipelineUsed: "production_probe",
          preRouterIntent: null,
          toolCallsExecuted: [],
          fallbackUsed: false,
          fallbackReason: null,
          validationWarnings: [],
          finalAction: "agent_probe_failed_closed",
          createdItemIds: [],
          updatedItemIds: [],
        },
      });
      return NextResponse.json(
        { ok: false, telemetry: error.telemetry, proposal: null },
        { status: 502 },
      );
    }
    await writeAudit({
      userId: owner.id,
      action: "assistant.agent_decision_trace",
      details: {
        ...proposed.telemetry,
        pipelineUsed: "production_probe",
        preRouterIntent: null,
        toolCallsExecuted: [],
        fallbackUsed: false,
        fallbackReason: null,
        validationWarnings: [],
        finalAction: "agent_probe_no_execution",
        createdItemIds: [],
        updatedItemIds: [],
      },
    });
    return NextResponse.json({
      ok: true,
      telemetry: proposed.telemetry,
      proposal: {
        intent: proposed.execution.intent,
        viewScope: proposed.execution.viewScope,
        resetMode: proposed.execution.resetMode,
        actionTypes: proposed.execution.actionPlan?.actions.map((action) => action.actionType) ?? [],
        kinds: proposed.execution.actionPlan?.actions.map((action) => action.kind) ?? [],
        titles: proposed.execution.actionPlan?.actions.map((action) => action.title) ?? [],
        startAtLocal:
          proposed.execution.actionPlan?.actions.map((action) => action.startAtLocal) ?? [],
        dueAtLocal:
          proposed.execution.actionPlan?.actions.map((action) => action.dueAtLocal) ?? [],
        updateItemIds: proposed.execution.itemUpdates.flatMap((update) => update.itemIds),
        updateOperations: proposed.execution.itemUpdates.map((update) => update.operation),
        updateStartAtLocal: proposed.execution.itemUpdates.map((update) => update.startAtLocal),
        updateEndAtLocal: proposed.execution.itemUpdates.map((update) => update.endAtLocal),
        reminderMinutesBefore: proposed.execution.itemUpdates.map(
          (update) => update.reminderMinutesBefore,
        ),
        followupMinutesAfter: proposed.execution.itemUpdates.map(
          (update) => update.followupMinutesAfter,
        ),
        exposeManagementButtons: proposed.execution.itemUpdates.map(
          (update) => update.exposeManagementButtons,
        ),
        reminderPolicyOperations: proposed.execution.reminderPolicies.map(
          (policy) => policy.operation,
        ),
        reminderPolicyTypes: proposed.execution.reminderPolicies.map(
          (policy) => policy.policyType,
        ),
        reminderPolicyTitles: proposed.execution.reminderPolicies.map(
          (policy) => policy.title,
        ),
        reminderPolicyCategories: proposed.execution.reminderPolicies.map(
          (policy) => policy.category,
        ),
        reminderPolicyStartsAtLocal: proposed.execution.reminderPolicies.map(
          (policy) => policy.startsAtLocal,
        ),
        reminderPolicyEndsAtLocal: proposed.execution.reminderPolicies.map(
          (policy) => policy.endsAtLocal,
        ),
        reminderPolicyIntervals: proposed.execution.reminderPolicies.map(
          (policy) => policy.intervalMinutes,
        ),
        reminderPolicyRecurrenceRules: proposed.execution.reminderPolicies.map(
          (policy) => policy.recurrenceRule,
        ),
        reminderPolicyRequireAck: proposed.execution.reminderPolicies.map(
          (policy) => policy.requireAck,
        ),
      },
    });
  }
  if (
    body.action === "agent_execute" &&
    typeof body.text === "string" &&
    body.confirm === true
  ) {
    const now = new Date();
    const context = await buildJarvisContext({
      userId: owner.id,
      timezone: owner.timezone,
      query: body.text,
      now,
    });
    let proposed;
    try {
      proposed = await proposeAgentExecution({
        text: body.text,
        timezone: owner.timezone,
        now,
        activeContext: context.activeContext,
      });
    } catch (error) {
      if (!(error instanceof MandatoryAiError)) throw error;
      await writeAgentExecutionAudit({
        userId: owner.id,
        telemetry: error.telemetry,
        finalAction: "agent_execute_failed_closed",
      });
      return NextResponse.json({ ok: false, telemetry: error.telemetry }, { status: 502 });
    }

    const createdItemIds: string[] = [];
    const updatedItemIds: string[] = [];
    const reminderIds: string[] = [];
    const policyIds: string[] = [];
    let createdReminderCount = 0;
    const toolCallsExecuted: string[] = [];
    const validationWarnings: string[] = [];
    let finalAction = "agent_execute_unsupported";
    const bound = bindContextualCompletionTarget({
      execution: proposed.execution,
      text: body.text,
      latestFollowupItemId: context.latestFollowupItemId,
    });
    validationWarnings.push(...bound.warnings);

    if (bound.execution.actionPlan) {
      const deduped = await filterDuplicateActionPlan({
        userId: owner.id,
        timezone: owner.timezone,
        plan: bound.execution.actionPlan,
      });
      const validation = validatePlannerItemsBeforeSave({
        plan: deduped.plan,
        originalMessage: body.text,
      });
      validationWarnings.push(...deduped.warnings);
      validationWarnings.push(...validation.warnings);
      if (!validation.ok) {
        await writeAgentExecutionAudit({
          userId: owner.id,
          telemetry: proposed.telemetry,
          finalAction: "agent_execute_blocked_by_validator",
          validationWarnings,
        });
        return NextResponse.json(
          { ok: false, error: "validation_failed", validationWarnings },
          { status: 422 },
        );
      }

      if (!deduped.plan.actions.length) {
        finalAction = "agent_execute_all_proposed_actions_already_exist";
      } else {
        toolCallsExecuted.push("create_action_plan");
        const storedPlan = await createStoredActionPlan({
          userId: owner.id,
          plan: deduped.plan,
          idempotencyKey: createIdempotencyKey([
            owner.id,
            body.text,
            "protected-agent-execute-v1",
          ]),
          commitMode: owner.smartCommitMode,
        });
        const committed = await commitStoredActionPlan({
          actionPlanId: storedPlan.id,
          userId: owner.id,
          timezone: owner.timezone,
          now,
        });
        if (committed.status === "committed") {
          createdItemIds.push(...committed.items.map((item) => item.id));
          createdReminderCount = committed.reminders.length;
          await syncItemsToCalendarBestEffort(committed.items);
          finalAction = "agent_execute_committed_action_plan";
        } else {
          finalAction = `agent_execute_${committed.status}`;
        }
      }
    } else if (bound.execution.itemUpdates.length) {
      toolCallsExecuted.push("update_existing_items");
      const updated = await applyAgentItemUpdates({
        userId: owner.id,
        updates: bound.execution.itemUpdates,
        timezone: owner.timezone,
        sourceText: body.text,
        now,
      });
      updatedItemIds.push(...updated.updatedItems.map((item) => item.id));
      reminderIds.push(...updated.reminderIds);
      validationWarnings.push(...updated.warnings);
      await syncItemsToCalendarBestEffort(updated.updatedItems);
      finalAction = "agent_execute_updated_existing_items";
    }

    if (bound.execution.reminderPolicies.length) {
      const [createdItems, manageableItems] = await Promise.all([
        listItemsByIds(owner.id, createdItemIds),
        listManageableItems(owner.id, 100),
      ]);
      const availableItems = [
        ...new Map([...createdItems, ...manageableItems].map((item) => [item.id, item])).values(),
      ];
      const applied = await applyAgentReminderPolicies({
        userId: owner.id,
        timezone: owner.timezone,
        proposals: bound.execution.reminderPolicies,
        availableItems,
        now,
      });
      policyIds.push(...applied.policies.map((policy) => policy.id));
      reminderIds.push(...applied.reminderIds);
      validationWarnings.push(...applied.warnings);
      toolCallsExecuted.push(
        ...new Set(bound.execution.reminderPolicies.map((policy) => policy.operation)),
      );
      if (applied.policies.length) finalAction = `${finalAction}_and_reminder_policies`;
    }

    await writeAgentExecutionAudit({
      userId: owner.id,
      telemetry: proposed.telemetry,
      finalAction,
      toolCallsExecuted,
      createdItemIds,
      updatedItemIds,
      validationWarnings,
    });
    return NextResponse.json({
      ok: toolCallsExecuted.length > 0,
      telemetry: proposed.telemetry,
      execution: {
        finalAction,
        toolCallsExecuted,
        createdItemIds,
        updatedItemIds,
        reminderIds,
        policyIds,
        createdReminderCount,
        validationWarnings,
      },
    });
  }

  return NextResponse.json({ ok: false, error: "unsupported_action" }, { status: 400 });
}

async function writeAgentExecutionAudit(params: {
  userId: string;
  telemetry: AiCallTelemetry;
  finalAction: string;
  toolCallsExecuted?: string[];
  createdItemIds?: string[];
  updatedItemIds?: string[];
  validationWarnings?: string[];
}) {
  await writeAudit({
    userId: params.userId,
    action: "assistant.agent_decision_trace",
    details: {
      ...params.telemetry,
      pipelineUsed: "production_execute",
      preRouterIntent: null,
      toolCallsExecuted: params.toolCallsExecuted ?? [],
      fallbackUsed: false,
      fallbackReason: null,
      validationWarnings: params.validationWarnings ?? [],
      finalAction: params.finalAction,
      createdItemIds: params.createdItemIds ?? [],
      updatedItemIds: params.updatedItemIds ?? [],
    },
  });
}
