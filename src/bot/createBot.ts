import { Bot } from "grammy";

import { requireEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { clearActiveInteractionSessions } from "@/bot/sessionRouting";
import { callbackReliabilityMiddleware } from "@/bot/callbackReliability";

import type { BotContext } from "./context";
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
