import {
  listPendingAgentActionsByTypes,
  updateAgentAction,
} from "@/db/queries/agentActions";
import { getReminderPolicyHealthStats } from "@/db/queries/reminderPolicies";
import {
  applyExternalCalendarCleanup,
  previewExternalCalendarCleanup,
} from "@/services/externalCalendarCleanup";
import { reconcileActiveReminderPolicies } from "@/services/reminderPolicyReconciler";

const EDIT_SESSION_TYPES = [
  "item_edit_session",
  "external_calendar_edit_session",
  "reminder_policy_edit_session",
];

export async function previewV270ProductionRepair(params: {
  userId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const [calendar, policyHealth, pendingSessions] = await Promise.all([
    previewExternalCalendarCleanup({ userId: params.userId, now }),
    getReminderPolicyHealthStats(),
    listPendingAgentActionsByTypes({
      userId: params.userId,
      actionTypes: EDIT_SESSION_TYPES,
    }),
  ]);
  const staleEditSessions = pendingSessions.filter((action) => {
    const expiresAt =
      typeof action.output?.expiresAt === "string" ? new Date(action.output.expiresAt) : null;
    return !expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= now;
  });
  return {
    calendar,
    reminderPoliciesToReconcile: policyHealth.policiesMissingNextReminder,
    staleEditSessions,
  };
}

export async function applyV270ProductionRepair(params: {
  userId: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const preview = await previewV270ProductionRepair({ ...params, now });
  const calendar = await applyExternalCalendarCleanup({ userId: params.userId, now });
  const reconcile = await reconcileActiveReminderPolicies({ now, limit: 300 });
  const clearedSessionIds: string[] = [];
  for (const action of preview.staleEditSessions) {
    const cleared = await updateAgentAction({
      userId: params.userId,
      actionId: action.id,
      status: "cancelled",
      output: {
        ...(action.output ?? {}),
        cancelledReason: "admin_repair_v270_stale_session",
        cancelledAt: now.toISOString(),
      },
    });
    if (cleared) clearedSessionIds.push(cleared.id);
  }
  return { preview, calendar, reconcile, clearedSessionIds };
}
