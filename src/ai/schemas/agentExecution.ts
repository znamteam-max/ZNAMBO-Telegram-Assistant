import { z } from "zod";

import { actionPlanSchema, memoryCandidateSchema } from "../schemas";

export const agentItemUpdateSchema = z
  .object({
    itemIds: z.array(z.string().uuid()).min(1),
    operation: z.enum(["configure", "complete", "reschedule"]),
    startAtLocal: z.string().nullable(),
    endAtLocal: z.string().nullable(),
    reminderMinutesBefore: z.number().int().positive().nullable(),
    followupMinutesAfter: z.number().int().nonnegative().nullable(),
    exposeManagementButtons: z.boolean(),
    note: z.string().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.operation === "configure" && (value.startAtLocal || value.endAtLocal)) {
      ctx.addIssue({
        code: "custom",
        message: "configure updates cannot change schedule",
      });
    }
    if (value.operation === "complete") {
      if (
        value.startAtLocal ||
        value.endAtLocal ||
        value.reminderMinutesBefore !== null ||
        value.followupMinutesAfter !== null
      ) {
        ctx.addIssue({
          code: "custom",
          message: "complete updates cannot change schedule or reminder policy",
        });
      }
    }
    if (value.operation === "reschedule" && !value.startAtLocal && !value.endAtLocal) {
      ctx.addIssue({
        code: "custom",
        message: "reschedule updates require a start or end time",
      });
    }
  });

export const agentReminderPolicySchema = z.object({
  operation: z.enum([
    "create_reminder_policy",
    "attach_reminder_policy_to_items",
    "create_interval_window_policy",
    "create_recurring_policy",
    "create_post_event_reaction_policy",
    "create_before_event_policy",
  ]),
  itemIds: z.array(z.string().uuid()),
  itemTitle: z.string().nullable(),
  title: z.string(),
  category: z.enum([
    "today_focus",
    "event",
    "pre_event",
    "post_event",
    "task_deadline",
    "nag_until_done",
    "long_term",
    "recurring_home",
    "recurring_car",
    "recurring_finance",
    "health",
    "training",
    "content",
    "admin",
    "project",
    "someday",
  ]),
  policyType: z.enum([
    "one_time",
    "before_event",
    "after_event",
    "post_event_menu",
    "interval_window",
    "recurring",
    "nag_until_ack",
    "long_term",
  ]),
  startsAtLocal: z.string().nullable(),
  endsAtLocal: z.string().nullable(),
  nextFireAtLocal: z.string().nullable(),
  recurrenceRule: z.string().nullable(),
  intervalMinutes: z.number().int().positive().nullable(),
  requireAck: z.boolean(),
  maxOccurrences: z.number().int().positive().nullable(),
  minutesBefore: z.number().int().positive().nullable(),
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
    "manage_reminder_policies",
  ]),
  reply: z.string().nullable(),
  actionPlan: actionPlanSchema.nullable(),
  viewScope: z
    .enum([
      "full",
      "today",
      "tomorrow",
      "week",
      "tasks",
      "yesterday",
      "evening",
      "dashboard",
      "reminders",
      "longterm",
    ])
    .nullable(),
  resetMode: z.enum(["all", "garbage"]).nullable(),
  itemUpdates: z.array(agentItemUpdateSchema),
  reminderPolicies: z.array(agentReminderPolicySchema).default([]),
  memoryFacts: z.array(memoryCandidateSchema),
  clarificationQuestions: z.array(z.string()),
});

export type AgentExecution = z.infer<typeof agentExecutionSchema>;
export type AgentItemUpdate = z.infer<typeof agentItemUpdateSchema>;
export type AgentReminderPolicy = z.infer<typeof agentReminderPolicySchema>;
