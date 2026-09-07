import type { BotContext } from "@/bot/context";
import { requireOwner } from "@/bot/context";
import { clearActiveInteractionSessions } from "@/bot/sessionRouting";
import { getPlannerItemById } from "@/db/queries/items";
import {
  createReminderPolicyIfMissing,
  listReminderPoliciesForItem,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelPendingRemindersForPolicy } from "@/db/queries/reminders";
import { writeAudit } from "@/db/queries/audit";
import {
  buildRecurringScheduleRule,
  nextRecurringScheduleOccurrence,
  parseRecurringScheduleFollowup,
  recurringSchedulePresetLabel,
  type RecurringSchedulePreset,
} from "@/domain/recurringScheduleEdit";
import {
  clearActiveReminderPolicyEditSession,
  getActiveReminderPolicyEditSession,
  startReminderPolicyEditSession,
  updateReminderPolicyEditSessionDraft,
} from "@/services/reminderPolicyEditSessions";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";
import {
  cleanupPolicyEditorMessages,
  registerBotMessage,
} from "@/telegram/messageLifecycle";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";

const SCHEDULE_PRESETS = new Set<RecurringSchedulePreset>([
  "daily",
  "weekdays",
  "weekly",
  "every_2_weeks",
  "monthly",
  "yearly",
]);

export async function startRecurringScheduleEdit(params: {
  ctx: BotContext;
  itemId: string;
  preset: RecurringSchedulePreset;
}) {
  const owner = requireOwner(params.ctx);
  const item = await getPlannerItemById(owner.id, params.itemId);
  if (!item || item.status !== "active") {
    await params.ctx.answerCallbackQuery("Задача не найдена");
    return false;
  }

  await clearActiveInteractionSessions({
    userId: owner.id,
    reason: "recurring_schedule_setup_started",
  });
  const action = await startReminderPolicyEditSession({
    userId: owner.id,
    itemId: item.id,
    section: "schedule",
    sourceMessageId: params.ctx.dbMessageId,
  });
  await updateReminderPolicyEditSessionDraft({
    userId: owner.id,
    actionId: action.id,
    draft: { recurrenceRule: params.preset },
  });

  await params.ctx.answerCallbackQuery("Жду время");
  if (params.ctx.chat?.id) {
    await cleanupPolicyEditorMessages({
      userId: owner.id,
      chatId: String(params.ctx.chat.id),
    }).catch(() => undefined);
  }
  const prompt = schedulePrompt(item.title, params.preset);
  const sent = await params.ctx.reply(prompt);
  if (params.ctx.chat?.id) {
    await registerBotMessage({
      userId: owner.id,
      chatId: String(params.ctx.chat.id),
      messageId: sent.message_id,
      purpose: "policy_editor",
      relatedItemId: item.id,
    }).catch(async (error) => {
      await writeAudit({
        userId: owner.id,
        action: "assistant.policy_editor_registry_failed_nonblocking",
        entityType: "planner_item",
        entityId: item.id,
        details: {
          flow: "recurring_schedule",
          safeErrorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        },
      }).catch(() => undefined);
    });
  }
  return true;
}

export async function handleRecurringScheduleEditTurn(
  ctx: BotContext,
  text: string,
  fallbackTimezone: string,
) {
  const owner = requireOwner(ctx);
  const session = await getActiveReminderPolicyEditSession({ userId: owner.id }).catch(() => null);
  if (!session || session.section !== "schedule") return false;

  const preset = session.draft.recurrenceRule as RecurringSchedulePreset | undefined;
  if (!preset || !SCHEDULE_PRESETS.has(preset)) return false;

  const parsed = parseRecurringScheduleFollowup(text);
  if (!parsed.timeLocal) {
    await ctx.reply(
      `Я меняю повторение именно у «${session.item.title}». Не вижу времени. Напиши, например: «8:00» или «8:00, повторять каждые 4 часа».`,
    );
    return true;
  }

  const timezone = session.item.timezone || fallbackTimezone;
  const now = new Date();
  const rule = buildRecurringScheduleRule({
    preset,
    timeLocal: parsed.timeLocal,
    now,
    timezone,
  });
  const nextFireAt = nextRecurringScheduleOccurrence({
    rule,
    preset,
    timeLocal: parsed.timeLocal,
    after: now,
    timezone,
  });
  if (!nextFireAt) {
    await ctx.reply("Не смог безопасно вычислить следующий повтор. Ничего не изменил.");
    return true;
  }

  const policies = await listReminderPoliciesForItem(owner.id, session.item.id, 100);
  const recurringPolicies = policies.filter((policy) =>
    ["recurring", "long_term"].includes(policy.policyType),
  );
  const existing =
    recurringPolicies.find((policy) => policy.status === "active") ?? recurringPolicies[0] ?? null;
  const intervalMinutes = parsed.intervalMinutes ?? null;
  const metadata = {
    configuredFrom: "reminder_schedule_menu",
    mutationSource: "recurring_schedule_edit_session",
    schedulePreset: preset,
    activeWindowStart: parsed.timeLocal,
    activeWindowEnd: intervalMinutes ? "23:59" : null,
    stopOnItemComplete: false,
    recurringParentPersistent: true,
  };

  if (existing) {
    await cancelPendingRemindersForPolicy({
      userId: owner.id,
      policyId: existing.id,
      from: new Date(0),
    });
  }

  let policy = existing
    ? await updateReminderPolicy({
        userId: owner.id,
        policyId: existing.id,
        itemId: session.item.id,
        status: "active",
        title: session.item.title,
        policyType: existing.policyType === "long_term" ? "long_term" : "recurring",
        timezone: undefined,
        startsAt: nextFireAt,
        endsAt: null,
        nextFireAt,
        recurrenceRule: rule,
        intervalMinutes,
        requireAck: intervalMinutes ? true : existing.requireAck,
        snoozedUntil: null,
        snoozeScope: null,
        metadata,
      } as Parameters<typeof updateReminderPolicy>[0])
    : null;

  if (!policy) {
    policy = await createReminderPolicyIfMissing({
      userId: owner.id,
      itemId: session.item.id,
      title: session.item.title,
      category: session.item.category ?? "recurring",
      policyType: "recurring",
      timezone,
      startsAt: nextFireAt,
      endsAt: null,
      nextFireAt,
      recurrenceRule: rule,
      intervalMinutes,
      requireAck: Boolean(intervalMinutes),
      catchUpMode: "one_immediate_then_resume",
      onWindowEnd: "expire_silently",
      idempotencyKey: `schedule-menu:${session.item.id}:${preset}`,
      metadata,
    });
    if (policy.status !== "active" || policy.nextFireAt?.getTime() !== nextFireAt.getTime()) {
      policy =
        (await updateReminderPolicy({
          userId: owner.id,
          policyId: policy.id,
          itemId: session.item.id,
          status: "active",
          title: session.item.title,
          policyType: "recurring",
          startsAt: nextFireAt,
          endsAt: null,
          nextFireAt,
          recurrenceRule: rule,
          intervalMinutes,
          requireAck: Boolean(intervalMinutes),
          snoozedUntil: null,
          snoozeScope: null,
          metadata,
        })) ?? policy;
    }
  }

  await materializeNextPolicyReminder(policy, nextFireAt, { now });
  await clearActiveReminderPolicyEditSession({ userId: owner.id, reason: "schedule_applied" });
  await writeAudit({
    userId: owner.id,
    action: "assistant.recurring_schedule_updated",
    entityType: "planner_item",
    entityId: session.item.id,
    details: {
      policyId: policy.id,
      recurrenceRule: rule,
      intervalMinutes,
      nextFireAt: nextFireAt.toISOString(),
      parentItemCreated: false,
      targetLocked: true,
    },
  }).catch(() => undefined);

  if (ctx.chat?.id) {
    await cleanupPolicyEditorMessages({
      userId: owner.id,
      chatId: String(ctx.chat.id),
    }).catch(() => undefined);
  }
  const intervalText = intervalMinutes
    ? `, каждые ${formatInterval(intervalMinutes)} до 23:59`
    : "";
  await ctx.reply(
    [
      "Готово:",
      `• ${session.item.title}`,
      `• ${recurringSchedulePresetLabel(preset)} в ${parsed.timeLocal}${intervalText}`,
      "Новых задач не создавал — изменил напоминания у выбранного пункта.",
    ].join("\n"),
  );

  ctx.deterministicTrace = {
    preRouterIntent: "recurring_schedule_edit_session",
    aiRequired: false,
    aiCalled: false,
    aiSucceeded: false,
    structuredOutputValid: true,
    toolCallsProposed: ["update_recurring_reminder_policy"],
    toolCallsExecuted: ["update_recurring_reminder_policy"],
    fallbackUsed: false,
    fallbackReason: null,
    validationWarnings: [],
    finalAction: "recurring_schedule_updated",
    errorCode: null,
    safeErrorMessage: null,
    sessionRouting: {
      handledBy: "recurring_schedule_edit_session",
      targetItemId: session.item.id,
      targetItemTitle: session.item.title,
      preset,
    },
  };

  if (ctx.chat?.id) {
    await refreshDashboardAfterMutation({
      userId: owner.id,
      chatId: ctx.chat.id,
      timezone: owner.timezone,
    });
  }
  return true;
}

function schedulePrompt(title: string, preset: RecurringSchedulePreset) {
  const label = recurringSchedulePresetLabel(preset);
  return [
    `Настраиваю повторение у «${title}»: ${label}.`,
    "Во сколько начинать?",
    "Можно одним сообщением: «8:00» или «8:00, повторять каждые 4 часа».",
  ].join("\n");
}

function formatInterval(minutes: number) {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "час" : hours >= 2 && hours <= 4 ? "часа" : "часов"}`;
  }
  return `${minutes} мин`;
}
