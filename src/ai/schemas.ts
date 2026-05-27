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
