import type { Context } from "grammy";

import type { User } from "@/db/schema";

export type BotContext = Context & {
  owner?: User;
  dbMessageId?: string;
};

export function requireOwner(ctx: BotContext): User {
  if (!ctx.owner) throw new Error("Authorized owner is missing from bot context");
  return ctx.owner;
}
