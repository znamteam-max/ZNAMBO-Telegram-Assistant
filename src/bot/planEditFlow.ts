import type { BotContext } from "@/bot/context";
import { requireOwner } from "@/bot/context";
import { replyAndRecord } from "@/bot/reply";
import { getActivePendingPlanEditSession } from "@/services/pendingPlanEditSessions";

/**
 * A user who explicitly pressed "edit plan" has selected a draft, not an arbitrary
 * existing planner item. Until we have a real in-place ActionPlan editor, free-text
 * follow-ups must fail closed instead of entering the global agent update router.
 *
 * Self-contained new creations are handled earlier by Jarvis scheduled/global creation
 * routing, which also clears this session. This handler therefore only sees ambiguous
 * follow-ups such as "18.00", "завтра" or "нет, в 19".
 */
export async function handlePendingPlanEditTurn(ctx: BotContext, text: string) {
  const owner = requireOwner(ctx);
  const session = await getActivePendingPlanEditSession({ userId: owner.id }).catch(() => null);
  if (!session) return false;

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
