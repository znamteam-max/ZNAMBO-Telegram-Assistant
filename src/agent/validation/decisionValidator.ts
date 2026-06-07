import type { JarvisDecision } from "../types";

const noCreateIntents = new Set<JarvisDecision["intent"]>([
  "render_full_plan",
  "render_today",
  "render_tomorrow",
  "render_week",
  "render_recent_range",
  "render_tasks",
  "render_yesterday_review",
  "render_evening_review",
  "delete_by_indices",
  "mark_done_by_indices",
  "cleanup_garbage",
  "reset_active_plan",
  "undo_last_action",
]);

export function validateJarvisDecision(decision: JarvisDecision): {
  ok: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (noCreateIntents.has(decision.intent) && decision.shouldCreateItems) {
    warnings.push("management_or_review_intent_would_create_items");
  }
  if (decision.intent !== "delegate_to_planner" && !decision.toolName) {
    warnings.push("jarvis_intent_missing_tool");
  }
  return { ok: warnings.length === 0, warnings };
}
