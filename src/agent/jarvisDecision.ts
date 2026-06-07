import type { JarvisDecision } from "./types";
import { detectHardManagementIntent } from "./hardManagementIntent";

export function decideJarvisTurn(text: string): JarvisDecision {
  const normalized = normalizeText(text);

  if (isUndoRequest(normalized)) {
    return decision("undo_last_action", "debug", false, "undo_last_action", "User asked to undo the latest agent action.");
  }

  const hardIntent = detectHardManagementIntent(normalized);
  if (hardIntent) return decisionFromHardIntent(hardIntent);

  return {
    intent: "delegate_to_planner",
    mode: "capture",
    confidence: 0.55,
    shouldCreateItems: true,
    toolName: null,
    reason: "No Jarvis management intent matched; delegate to the existing V2 planner.",
  };
}

function decisionFromHardIntent(
  hardIntent: NonNullable<ReturnType<typeof detectHardManagementIntent>>,
): JarvisDecision {
  switch (hardIntent.intent) {
    case "reset_active_plan":
      return decision("reset_active_plan", "cleanup", false, "prepare_reset_active_plan", "Hard reset-active-plan intent.");
    case "render_recent_range":
      return decision("render_recent_range", "answer", false, "render_recent_range", "Hard recent-range view intent.");
    case "render_full_plan":
      return decision("render_full_plan", "answer", false, "render_schedule_view", "Hard full-plan view intent.");
    case "render_today":
      return decision("render_today", "answer", false, "render_schedule_view", "Hard today view intent.");
    case "render_tomorrow":
      return decision("render_tomorrow", "answer", false, "render_schedule_view", "Hard tomorrow view intent.");
    case "render_week":
      return decision("render_week", "answer", false, "render_schedule_view", "Hard week view intent.");
    case "render_tasks":
      return decision("render_tasks", "manage", false, "render_task_view", "Hard task view intent.");
    case "render_yesterday_review":
      return decision("render_yesterday_review", "review", false, "render_yesterday_review", "Hard yesterday review intent.");
    case "render_evening_review":
      return decision("render_evening_review", "review", false, "render_evening_review", "Hard evening review intent.");
    case "cleanup_garbage":
      return decision("cleanup_garbage", "cleanup", false, "cleanup_garbage", "Hard cleanup intent.");
    case "delete_by_indices":
      return decision("delete_by_indices", "manage", false, "delete_items_by_indices", "Hard delete-by-index intent.");
    case "mark_done_by_indices":
      return decision("mark_done_by_indices", "manage", false, "mark_done_by_indices", "Hard done-by-index intent.");
    case "reschedule_by_indices":
      return decision("render_tasks", "manage", false, "render_task_view", "Reschedule requires a task view and clarification.");
  }
}

function decision(
  intent: JarvisDecision["intent"],
  mode: JarvisDecision["mode"],
  shouldCreateItems: boolean,
  toolName: JarvisDecision["toolName"],
  reason: string,
): JarvisDecision {
  return {
    intent,
    mode,
    confidence: 0.96,
    shouldCreateItems,
    toolName,
    reason,
  };
}

function normalizeText(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ");
}

function isUndoRequest(text: string) {
  return /^(undo|откат|отмени последнее|верни как было|назад)/i.test(text);
}
