import type { BotContext } from "@/bot/context";
import { requireOwner } from "@/bot/context";

import { detectHardManagementIntent } from "./hardManagementIntent";
import {
  cleanupGarbageTool,
  deleteItemsByIndicesTool,
  markDoneByIndicesTool,
  prepareResetActivePlanTool,
  renderEveningReviewTool,
  renderRecentRangeTool,
  renderScheduleViewTool,
  renderTaskViewTool,
  renderYesterdayReviewTool,
} from "./jarvisTools";
import type { JarvisToolResult } from "./types";

export async function handleHardManagementIntent(params: {
  ctx: BotContext;
  text: string;
  timezone: string;
  now?: Date;
}): Promise<{ intent: string; result: JarvisToolResult } | null> {
  const managementIntent = detectHardManagementIntent(params.text);
  if (!managementIntent) return null;
  const owner = requireOwner(params.ctx);
  const base = {
    userId: owner.id,
    timezone: params.timezone,
    now: params.now ?? new Date(),
    sourceMessageId: params.ctx.dbMessageId,
  };

  switch (managementIntent.intent) {
    case "reset_active_plan":
      return { intent: managementIntent.intent, result: await prepareResetActivePlanTool(base) };
    case "render_recent_range":
      return {
        intent: managementIntent.intent,
        result: await renderRecentRangeTool({ ...base, days: managementIntent.days }),
      };
    case "render_full_plan":
      return { intent: managementIntent.intent, result: await renderScheduleViewTool({ ...base, scope: "full" }) };
    case "render_today":
      return { intent: managementIntent.intent, result: await renderScheduleViewTool({ ...base, scope: "today" }) };
    case "render_tomorrow":
      return { intent: managementIntent.intent, result: await renderScheduleViewTool({ ...base, scope: "tomorrow" }) };
    case "render_week":
      return { intent: managementIntent.intent, result: await renderScheduleViewTool({ ...base, scope: "week" }) };
    case "render_tasks":
      return { intent: managementIntent.intent, result: await renderTaskViewTool(base) };
    case "render_yesterday_review":
      return { intent: managementIntent.intent, result: await renderYesterdayReviewTool(base) };
    case "render_evening_review":
      return { intent: managementIntent.intent, result: await renderEveningReviewTool(base) };
    case "cleanup_garbage":
      return { intent: managementIntent.intent, result: await cleanupGarbageTool(base) };
    case "delete_by_indices":
      return { intent: managementIntent.intent, result: await deleteItemsByIndicesTool({ ...base, text: params.text }) };
    case "mark_done_by_indices":
      return { intent: managementIntent.intent, result: await markDoneByIndicesTool({ ...base, text: params.text }) };
    case "reschedule_by_indices":
      return {
        intent: managementIntent.intent,
        result: {
          handled: true,
          reply: "Понял, это перенос существующей задачи. Ничего нового не создаю. Укажи номер и новое время, например: «4 на завтра 11:30».",
          affectedItemIds: [],
          status: "noop",
        },
      };
  }
}
