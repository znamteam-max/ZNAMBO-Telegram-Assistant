import type { TaskViewState } from "@/db/schema";
import type { InlineKeyboard } from "grammy";

export type JarvisMode =
  | "answer"
  | "capture"
  | "manage"
  | "review"
  | "cleanup"
  | "debug";

export type JarvisIntent =
  | "render_full_plan"
  | "render_today"
  | "render_tomorrow"
  | "render_week"
  | "render_recent_range"
  | "render_tasks"
  | "render_yesterday_review"
  | "render_evening_review"
  | "reset_active_plan"
  | "delete_by_indices"
  | "mark_done_by_indices"
  | "cleanup_garbage"
  | "undo_last_action"
  | "delegate_to_planner";

export type JarvisToolName =
  | "render_schedule_view"
  | "render_task_view"
  | "render_yesterday_review"
  | "render_evening_review"
  | "render_recent_range"
  | "prepare_reset_active_plan"
  | "delete_items_by_indices"
  | "mark_done_by_indices"
  | "cleanup_garbage"
  | "undo_last_action";

export type JarvisDecision = {
  intent: JarvisIntent;
  mode: JarvisMode;
  confidence: number;
  shouldCreateItems: boolean;
  toolName: JarvisToolName | null;
  reason: string;
};

export type JarvisContext = {
  now: Date;
  timezone: string;
  activeContext: string;
  contextError: string | null;
  lastTaskViewState: TaskViewState | null;
  latestFollowupItemId: string | null;
  latestFollowupDeliveredAt: Date | null;
};

export type JarvisToolResult = {
  handled: boolean;
  reply: string;
  affectedItemIds: string[];
  viewStateId?: string | null;
  status?: "completed" | "noop" | "failed";
  metadata?: Record<string, unknown>;
  replyMarkup?: InlineKeyboard;
};
