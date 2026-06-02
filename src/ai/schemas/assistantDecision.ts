import { z } from "zod";

export const assistantIntentSchema = z.enum([
  "create_or_update_plan",
  "ordered_task_list",
  "manage_existing_items",
  "training_report",
  "tentative_training_plan",
  "memory_update",
  "status_query",
  "delete_or_cancel",
  "reschedule",
  "mark_done",
  "clarification",
  "conversation",
]);

export const suggestedButtonSchema = z.object({
  label: z.string(),
  action: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const extractedItemSchema = z.object({
  type: z.enum(["task", "event", "call", "training", "reminder", "preparation", "follow_up", "note"]),
  title: z.string(),
  description: z.string().optional(),
  date: z.string().optional(),
  time: z.string().optional(),
  endTime: z.string().optional(),
  timezone: z.string().optional(),
  isTentative: z.boolean().default(false),
  isFloating: z.boolean().default(false),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  sourceFragment: z.string(),
});

export const orderedTaskListSchema = z.object({
  title: z.string(),
  date: z.string(),
  items: z.array(
    z.object({
      order: z.number().int().positive(),
      title: z.string(),
      type: z.enum(["task", "call", "event", "content", "admin"]),
      time: z.string().optional(),
      isFloating: z.boolean().default(true),
      sourceFragment: z.string(),
    }),
  ),
  preserveOrder: z.boolean().default(true),
});

export const trainingReportSchema = z.object({
  dateRefs: z.array(
    z.object({
      date: z.string(),
      status: z.enum(["completed", "missed", "partial"]),
      summary: z.string(),
    }),
  ),
  notes: z.string().optional(),
});

export const tentativePlanSchema = z.object({
  date: z.string(),
  title: z.string(),
  type: z.enum(["training", "event", "task"]),
  timeWindow: z.enum(["morning", "day", "morning_day", "evening", "night", "unknown"]).default("unknown"),
  distanceKm: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
    })
    .optional(),
  intensity: z.string().optional(),
  askToFinalizeAt: z.string().optional(),
});

export const assistantDecisionSchema = z.object({
  intent: assistantIntentSchema,
  confidence: z.number().min(0).max(1),
  shouldCreateItems: z.boolean(),
  shouldAskConfirmation: z.boolean().default(false),
  shouldAskClarifyingQuestion: z.boolean().default(false),
  userFacingSummary: z.string(),
  extractedItems: z.array(extractedItemSchema).default([]),
  orderedTasks: orderedTaskListSchema.optional(),
  trainingReport: trainingReportSchema.optional(),
  tentativePlan: tentativePlanSchema.optional(),
  memoryFacts: z.array(z.object({ category: z.string(), content: z.string(), searchTags: z.array(z.string()).default([]) })).default([]),
  correctionRules: z.array(z.object({ category: z.string(), content: z.string(), searchTags: z.array(z.string()).default([]) })).default([]),
  managementRequest: z
    .object({
      target: z.enum(["today", "tomorrow", "week", "tasks", "current", "overdue"]),
      action: z.enum(["show", "edit", "delete", "reschedule", "complete", "reorder"]),
    })
    .optional(),
  clarificationQuestion: z.string().optional(),
  suggestedButtons: z.array(suggestedButtonSchema).default([]),
  validatorWarnings: z.array(z.string()).default([]),
});

export type AssistantIntent = z.infer<typeof assistantIntentSchema>;
export type AssistantDecision = z.infer<typeof assistantDecisionSchema>;
export type OrderedTaskList = z.infer<typeof orderedTaskListSchema>;
export type TrainingReport = z.infer<typeof trainingReportSchema>;
export type TentativePlan = z.infer<typeof tentativePlanSchema>;
