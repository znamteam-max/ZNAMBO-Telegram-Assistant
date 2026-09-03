import type { BotContext } from "@/bot/context";
import { requireOwner } from "@/bot/context";
import { replyAndRecord } from "@/bot/reply";
import { isGlobalCreationIntent } from "@/bot/sessionRouting";
import { looksLikeExplicitNewScheduledCreationText } from "@/domain/scheduledCreationIntent";
import {
  clearPendingPlanEditSession,
  getActivePendingPlanEditSession,
} from "@/services/pendingPlanEditSessions";

/**
 * A user who explicitly pressed "edit plan" has selected a draft, not an arbitrary
 * existing planner item. Until we have a real in-place ActionPlan editor, ambiguous
 * free-text follow-ups must fail closed instead of entering the global update router.
 *
 * A self-contained replacement (for example "Созвон ... сегодня в 18:00" or an
 * explicit "добавь задачу ...") is allowed to escape the lock and is then handled by
 * the normal creation pipeline. The old pending plan was already cancelled when the
 * user pressed Edit.
 */
export async function handlePendingPlanEditTurn(ctx: BotContext, text: string) {
  const owner = requireOwner(ctx);
  const session = await getActivePendingPlanEditSession({ userId: owner.id }).catch(() => null);
  if (!session) return false;

  if (looksLikeExplicitNewScheduledCreationText(text) || isGlobalCreationIntent(text)) {
    await clearPendingPlanEditSession({
      userId: owner.id,
      reason: "self_contained_plan_edit_replacement",
    });
    return false;
  }

  ctx.deterministicTrace = {
    preRouterIntent: "pending_plan_edit_session",
    aiRequired: false,
    aiCalled: false,
    aiSucceeded: false,
    structuredOutputValid: true,
    toolCallsProposed: [],
    toolCallsExecuted: ["block_ambiguous_plan_edit_followup"],
    fallbackUsed: false,
    fallbackReason: null,
    validationWarnings: ["plan_edit_followup_requires_self_contained_text"],
    finalAction: "plan_edit_followup_blocked_before_global_mutation",
    errorCode: null,
    safeErrorMessage: null,
    sessionRouting: {
      handledBy: "pending_plan_edit_session",
      actionPlanId: session.actionPlanId,
      blockedGlobalMutation: true,
    },
  };

  await replyAndRecord(
    ctx,
    [
      "Чтобы не изменить другую задачу, короткий ответ к старому плану не применяю.",
      "Пришли исправленный пункт целиком одним сообщением.",
      "Например: «Созвон по Взял Мяч сегодня в 18:00» или «Добавь задачу проверить отчёт завтра до 12:00».",
      "Старый вариант плана уже отменён.",
    ].join("\n"),
  );
  return true;
}
