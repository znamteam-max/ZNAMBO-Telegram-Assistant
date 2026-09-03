import { Bot, InputFile } from "grammy";

import { requireEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { buildActionLog } from "@/services/actionLog";
import { buildFullJournal, parseFullJournalArgs } from "@/services/fullJournal";
import { buildOpenAiUsageSummary } from "@/services/openAiUsageSummary";
import { buildTraceExport, parseTraceExportArgs } from "@/services/traceExport";
import { clearActiveInteractionSessions } from "@/bot/sessionRouting";
import { callbackReliabilityMiddleware } from "@/bot/callbackReliability";
import { installFullJournalTelegramRecorder } from "@/telegram/fullJournalRecorder";
import { cancelStoredActionPlan } from "@/services/actionPlanCommit";
import { startPendingPlanEditSession } from "@/services/pendingPlanEditSessions";

import { requireOwner, type BotContext } from "./context";
import { attachOwner, requireAllowedOwner } from "./authorization";
import { registerCallbacks } from "./callbacks";
import { registerCommands } from "./commands";
import { registerMessageHandlers } from "./messageHandlers";
import { recordUpdateOnce } from "./updateRecorder";
import { stabilityScheduleReminderMenuKeyboard } from "./stabilityKeyboards";

const READ_ONLY_DIAGNOSTIC_COMMANDS = new Set([
  "actionlog",
  "actionlog_export",
  "fulllog_export",
  "trace_export",
  "debugrecent",
  "debuglast",
  "bugrecent",
  "apiusage",
  "aihealth",
  "cronhealth",
  "policydebug",
  "versiondebug",
  "admin_time_debug",
  "calendar_import_status",
  "calendardebug",
]);

let bot: Bot<BotContext> | null = null;
let botInitPromise: Promise<void> | null = null;

export function createBot() {
  const instance = new Bot<BotContext>(requireEnv("TELEGRAM_BOT_TOKEN"));
  installFullJournalTelegramRecorder(instance);
  instance.use(requireAllowedOwner);
  instance.use(attachOwner);
  instance.use(recordUpdateOnce);
  instance.use(callbackReliabilityMiddleware());
  instance.use(async (ctx, next) => {
    const text = ctx.message?.text ?? ctx.editedMessage?.text ?? "";
    const command = slashCommandName(text);
    if (
      command &&
      command !== "cancel" &&
      !READ_ONLY_DIAGNOSTIC_COMMANDS.has(command) &&
      ctx.owner?.id
    ) {
      await clearActiveInteractionSessions({
        userId: ctx.owner.id,
        reason: "slash_command",
      });
    }
    await next();
  });

  // Selecting "edit plan" now creates a durable target lock. The old draft is cancelled
  // immediately, so its stale Save button cannot later commit it. Ambiguous follow-ups
  // such as "18.00" are blocked before the global update_existing_items router.
  instance.callbackQuery(/^(?:plan|pa):edit:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const actionPlanId = String(ctx.match?.[1] ?? "");
    await clearActiveInteractionSessions({
      userId: owner.id,
      reason: "plan_edit_requested",
    });
    await cancelStoredActionPlan({ actionPlanId, userId: owner.id }).catch(() => null);
    await startPendingPlanEditSession({
      userId: owner.id,
      actionPlanId,
      sourceMessageId: ctx.dbMessageId,
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "Пришли исправленный пункт целиком одним сообщением.",
        "Например: «Созвон по Взял Мяч сегодня в 18:00».",
        "Старый вариант плана отменён, поэтому короткое «18.00» не сможет изменить другую задачу.",
      ].join("\n"),
    );
  });

  // The legacy schedule menu contains a callback payload that can exceed Telegram's
  // 64-byte callback_data limit for UUID item ids. Intercept this menu before the
  // legacy callback handler so one invalid option cannot break the whole keyboard.
  instance.callbackQuery(/^policy_menu:schedule:(.+)$/, async (ctx) => {
    const itemId = String(ctx.match?.[1] ?? "");
    await ctx.answerCallbackQuery();
    await ctx.reply("Как повторять?", {
      reply_markup: stabilityScheduleReminderMenuKeyboard(itemId),
    });
  });

  // Backward-compatible direct alias. This bypasses the natural-language router entirely.
  instance.command("actionlog_export", async (ctx) => {
    const owner = requireOwner(ctx);
    const log = await buildActionLog({
      userId: owner.id,
      hours: 24,
      limit: 200,
      exportMode: true,
    });
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(log.text, "utf8"), "znambo_actionlog.txt"),
      { caption: "Action log export без секретов." },
    );
  });

  instance.command("fulllog_export", async (ctx) => {
    const owner = requireOwner(ctx);
    const range = parseFullJournalArgs(typeof ctx.match === "string" ? ctx.match : "");
    const journal = await buildFullJournal({
      userId: owner.id,
      hours: range.hours,
      all: range.all,
    });
    const suffix = range.all ? "all" : `${range.hours}h`;
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(journal.text, "utf8"), `jarvis_full_journal_${suffix}.md`),
      {
        caption: journal.truncated
          ? `Полный журнал: ${journal.eventCount} событий. Достигнут защитный лимит строк; для полного архива выгрузи меньший диапазон.`
          : `Полный журнал: ${journal.eventCount} событий. Включены сообщения, расшифровки, ответы/удаления и внутренние state/action traces без секретов.`,
      },
    );
  });

  instance.command("trace_export", async (ctx) => {
    const owner = requireOwner(ctx);
    const range = parseTraceExportArgs(typeof ctx.match === "string" ? ctx.match : "");
    const trace = await buildTraceExport({
      userId: owner.id,
      hours: range.hours,
    });
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(trace.text, "utf8"), `jarvis_trace_${range.hours}h.md`),
      {
        caption: trace.truncated
          ? `Causal trace: ${trace.turnCount} пользовательских ходов. Достигнут защитный лимит строк.`
          : `Causal trace: ${trace.turnCount} пользовательских ходов. Команда read-only и не сбрасывает активную настройку.`,
      },
    );
  });

  instance.command("apiusage", async (ctx) => {
    const owner = requireOwner(ctx);
    const usage = await buildOpenAiUsageSummary({
      userId: owner.id,
      timezone: owner.timezone,
    });
    await ctx.reply(usage.text);
  });

  registerCommands(instance);
  registerCallbacks(instance);
  registerMessageHandlers(instance);

  instance.catch((error) => {
    logger.error("Bot update failed", {
      error: error.error instanceof Error ? error.error.message : String(error.error),
    });
  });

  return instance;
}

export function slashCommandName(text: string) {
  const match = text.trim().match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s|$)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function isReadOnlyDiagnosticCommand(text: string) {
  const command = slashCommandName(text);
  return Boolean(command && READ_ONLY_DIAGNOSTIC_COMMANDS.has(command));
}

export function getBot() {
  if (!bot) bot = createBot();
  return bot;
}

export async function getInitializedBot() {
  const instance = getBot();
  botInitPromise ??= instance.init();
  await botInitPromise;
  return instance;
}
