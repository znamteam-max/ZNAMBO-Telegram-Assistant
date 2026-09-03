import { Bot, InputFile } from "grammy";

import { requireEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { buildActionLog } from "@/services/actionLog";
import { clearActiveInteractionSessions } from "@/bot/sessionRouting";
import { callbackReliabilityMiddleware } from "@/bot/callbackReliability";

import { requireOwner, type BotContext } from "./context";
import { attachOwner, requireAllowedOwner } from "./authorization";
import { registerCallbacks } from "./callbacks";
import { registerCommands } from "./commands";
import { registerMessageHandlers } from "./messageHandlers";
import { recordUpdateOnce } from "./updateRecorder";

let bot: Bot<BotContext> | null = null;
let botInitPromise: Promise<void> | null = null;

export function createBot() {
  const instance = new Bot<BotContext>(requireEnv("TELEGRAM_BOT_TOKEN"));
  instance.use(requireAllowedOwner);
  instance.use(attachOwner);
  instance.use(recordUpdateOnce);
  instance.use(callbackReliabilityMiddleware());
  instance.use(async (ctx, next) => {
    const text = ctx.message?.text ?? ctx.editedMessage?.text ?? "";
    if (text.startsWith("/") && !text.toLowerCase().startsWith("/cancel") && ctx.owner?.id) {
      await clearActiveInteractionSessions({
        userId: ctx.owner.id,
        reason: "slash_command",
      });
    }
    await next();
  });

  // A plan-correction prompt must never leave an unrelated item/policy edit session alive.
  // Otherwise the next free-text answer (for example "18.00") can mutate the wrong item.
  instance.callbackQuery(/^(?:plan|pa):edit:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await clearActiveInteractionSessions({
      userId: owner.id,
      reason: "plan_edit_requested",
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Пришли исправленную формулировку одним сообщением. Старый план не меняю автоматически.",
    );
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
