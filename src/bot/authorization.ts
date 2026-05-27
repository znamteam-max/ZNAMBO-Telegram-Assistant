import type { NextFunction } from "grammy";

import { getOrCreateOwnerUser } from "@/db/queries/users";
import { getAllowedTelegramUserIds } from "@/lib/env";

import type { BotContext } from "./context";

export function isAllowedTelegramUserId(telegramUserId: number | string | bigint): boolean {
  const allowed = getAllowedTelegramUserIds();
  return allowed.has(String(telegramUserId));
}

export async function requireAllowedOwner(ctx: BotContext, next: NextFunction) {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId || !isAllowedTelegramUserId(telegramUserId)) {
    if (ctx.chat?.id) {
      await ctx.reply("Нет доступа.");
    }
    return;
  }
  await next();
}

export async function attachOwner(ctx: BotContext, next: NextFunction) {
  if (!ctx.from) return;
  ctx.owner = await getOrCreateOwnerUser({
    id: ctx.from.id,
    username: ctx.from.username,
    firstName: ctx.from.first_name,
  });
  await next();
}
