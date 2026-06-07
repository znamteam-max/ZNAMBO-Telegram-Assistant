import { z } from "zod";

import { actionPlanSchema, memoryCandidateSchema } from "../schemas";

export const agentItemUpdateSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1),
  reminderMinutesBefore: z.number().int().positive().nullable(),
  followupMinutesAfter: z.number().int().nonnegative().nullable(),
  exposeManagementButtons: z.boolean(),
  note: z.string().nullable(),
});

export const agentExecutionSchema = z.object({
  intent: z.enum([
    "create_plan",
    "update_existing_items",
    "render_view",
    "reset_active_plan",
    "cleanup_garbage",
    "store_memory",
    "reply",
    "clarify",
  ]),
  reply: z.string().nullable(),
  actionPlan: actionPlanSchema.nullable(),
  viewScope: z.enum(["full", "today", "tomorrow", "week", "tasks", "yesterday", "evening"]).nullable(),
  resetMode: z.enum(["all", "garbage"]).nullable(),
  itemUpdates: z.array(agentItemUpdateSchema),
  memoryFacts: z.array(memoryCandidateSchema),
  clarificationQuestions: z.array(z.string()),
});

export type AgentExecution = z.infer<typeof agentExecutionSchema>;
export type AgentItemUpdate = z.infer<typeof agentItemUpdateSchema>;

