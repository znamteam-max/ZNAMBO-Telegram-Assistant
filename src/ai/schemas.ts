import { z } from "zod";

import { itemKinds, reminderTypes } from "@/domain/types";

export const memoryCandidateSchema = z.object({
  category: z
    .enum(["preference", "project", "person", "routine", "meeting_pattern"])
    .default("project"),
  content: z.string().min(1),
  searchTags: z.array(z.string()).default([]),
});

export const plannerActionProposalSchema = z.object({
  intent: z
    .enum(["create_item", "answer", "ambiguous", "modify_item", "delete_item"])
    .default("create_item"),
  kind: z.enum(itemKinds).nullable().default(null),
  title: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  timezone: z.string().nullable().default(null),
  startAtLocal: z.string().nullable().default(null),
  endAtLocal: z.string().nullable().default(null),
  dueAtLocal: z.string().nullable().default(null),
  durationMinutes: z.number().int().positive().nullable().default(null),
  priority: z.number().int().min(1).max(5).default(3),
  reminderPresets: z.array(z.enum(reminderTypes)).default([]),
  reply: z.string().nullable().default(null),
  requiresConfirmation: z.boolean().default(true),
  confidence: z.number().min(0).max(1).default(0.5),
  memoryCandidates: z.array(memoryCandidateSchema).default([]),
  preparationPrompt: z.string().nullable().default(null),
  disambiguationOptions: z
    .array(
      z.object({
        label: z.string(),
        details: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

export type PlannerActionProposal = z.infer<typeof plannerActionProposalSchema>;

export const recurrenceDays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export const actionPlanReminderSchema = z.object({
  type: z.enum(reminderTypes).default("custom"),
  scheduledAtLocal: z.string().nullable().default(null),
  offsetMinutesBefore: z.number().int().positive().nullable().default(null),
  repeatUntilAck: z.boolean().default(false),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const actionPlanItemSchema = z.object({
  actionType: z
    .enum([
      "event",
      "task",
      "preparation",
      "training",
      "tentative_event",
      "recurring_task",
      "reminder",
      "note",
      "followup",
    ])
    .default("task"),
  kind: z.enum(itemKinds).default("task"),
  title: z.string().min(1),
  description: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  timezone: z.string().nullable().default(null),
  startAtLocal: z.string().nullable().default(null),
  endAtLocal: z.string().nullable().default(null),
  dueAtLocal: z.string().nullable().default(null),
  durationMinutes: z.number().int().positive().nullable().default(null),
  priority: z.number().int().min(1).max(5).default(3),
  confidence: z.number().min(0).max(1).default(0.65),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  requiresConfirmation: z.boolean().default(false),
  tentative: z.boolean().default(false),
  recurrence: z
    .object({
      frequency: z.enum(["none", "daily", "weekly"]).default("none"),
      daysOfWeek: z.array(z.enum(recurrenceDays)).default([]),
      timeLocal: z.string().nullable().default(null),
      repeatUntilAck: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  reminders: z.array(actionPlanReminderSchema).default([]),
  memoryCandidates: z.array(memoryCandidateSchema).default([]),
});

export const actionPlanSchema = z.object({
  intent: z.enum(["plan", "answer", "clarify"]).default("plan"),
  summary: z.string().nullable().default(null),
  reply: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.65),
  requiresConfirmation: z.boolean().default(false),
  actions: z.array(actionPlanItemSchema).default([]),
  memoryCandidates: z.array(memoryCandidateSchema).default([]),
  clarificationQuestions: z.array(z.string()).default([]),
});

export type ActionPlanReminder = z.infer<typeof actionPlanReminderSchema>;
export type ActionPlanItem = z.infer<typeof actionPlanItemSchema>;
export type ActionPlan = z.infer<typeof actionPlanSchema>;

const reminderJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "scheduledAtLocal", "offsetMinutesBefore", "repeatUntilAck", "payload"],
  properties: {
    type: { type: "string", enum: reminderTypes },
    scheduledAtLocal: { type: ["string", "null"] },
    offsetMinutesBefore: { type: ["integer", "null"], minimum: 1 },
    repeatUntilAck: { type: "boolean" },
    payload: { type: "object", additionalProperties: true },
  },
} as const;

const memoryCandidateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "content", "searchTags"],
  properties: {
    category: {
      type: "string",
      enum: ["preference", "project", "person", "routine", "meeting_pattern"],
    },
    content: { type: "string" },
    searchTags: { type: "array", items: { type: "string" } },
  },
} as const;

export const actionPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent",
    "summary",
    "reply",
    "confidence",
    "requiresConfirmation",
    "actions",
    "memoryCandidates",
    "clarificationQuestions",
  ],
  properties: {
    intent: { type: "string", enum: ["plan", "answer", "clarify"] },
    summary: { type: ["string", "null"] },
    reply: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    requiresConfirmation: { type: "boolean" },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "actionType",
          "kind",
          "title",
          "description",
          "location",
          "timezone",
          "startAtLocal",
          "endAtLocal",
          "dueAtLocal",
          "durationMinutes",
          "priority",
          "confidence",
          "risk",
          "requiresConfirmation",
          "tentative",
          "recurrence",
          "reminders",
          "memoryCandidates",
        ],
        properties: {
          actionType: {
            type: "string",
            enum: [
              "event",
              "task",
              "preparation",
              "training",
              "tentative_event",
              "recurring_task",
              "reminder",
              "note",
              "followup",
            ],
          },
          kind: { type: "string", enum: itemKinds },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
          timezone: { type: ["string", "null"] },
          startAtLocal: { type: ["string", "null"] },
          endAtLocal: { type: ["string", "null"] },
          dueAtLocal: { type: ["string", "null"] },
          durationMinutes: { type: ["integer", "null"], minimum: 1 },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          requiresConfirmation: { type: "boolean" },
          tentative: { type: "boolean" },
          recurrence: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["frequency", "daysOfWeek", "timeLocal", "repeatUntilAck"],
                properties: {
                  frequency: { type: "string", enum: ["none", "daily", "weekly"] },
                  daysOfWeek: {
                    type: "array",
                    items: { type: "string", enum: recurrenceDays },
                  },
                  timeLocal: { type: ["string", "null"] },
                  repeatUntilAck: { type: "boolean" },
                },
              },
            ],
          },
          reminders: { type: "array", items: reminderJsonSchema },
          memoryCandidates: { type: "array", items: memoryCandidateJsonSchema },
        },
      },
    },
    memoryCandidates: { type: "array", items: memoryCandidateJsonSchema },
    clarificationQuestions: { type: "array", items: { type: "string" } },
  },
} as const;

export const plannerActionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent",
    "kind",
    "title",
    "description",
    "location",
    "timezone",
    "startAtLocal",
    "endAtLocal",
    "dueAtLocal",
    "durationMinutes",
    "priority",
    "reminderPresets",
    "reply",
    "requiresConfirmation",
    "confidence",
    "memoryCandidates",
    "preparationPrompt",
    "disambiguationOptions",
  ],
  properties: {
    intent: {
      type: "string",
      enum: ["create_item", "answer", "ambiguous", "modify_item", "delete_item"],
    },
    kind: { type: ["string", "null"], enum: [...itemKinds, null] },
    title: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    location: { type: ["string", "null"] },
    timezone: { type: ["string", "null"] },
    startAtLocal: {
      type: ["string", "null"],
      description: "Local ISO datetime without UTC conversion, for example 2026-05-28T12:00:00",
    },
    endAtLocal: {
      type: ["string", "null"],
      description: "Local ISO datetime without UTC conversion, for example 2026-05-28T13:00:00",
    },
    dueAtLocal: {
      type: ["string", "null"],
      description: "Local ISO datetime for task deadline, if any.",
    },
    durationMinutes: { type: ["integer", "null"], minimum: 1 },
    priority: { type: "integer", minimum: 1, maximum: 5 },
    reminderPresets: {
      type: "array",
      items: { type: "string", enum: reminderTypes },
    },
    reply: { type: ["string", "null"] },
    requiresConfirmation: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    memoryCandidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "content", "searchTags"],
        properties: {
          category: {
            type: "string",
            enum: ["preference", "project", "person", "routine", "meeting_pattern"],
          },
          content: { type: "string" },
          searchTags: { type: "array", items: { type: "string" } },
        },
      },
    },
    preparationPrompt: { type: ["string", "null"] },
    disambiguationOptions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "details"],
        properties: {
          label: { type: "string" },
          details: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;
