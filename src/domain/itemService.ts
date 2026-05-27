import { DateTime } from "luxon";

import type { PlannerActionProposal } from "@/ai/schemas";
import { UserFacingError } from "@/lib/errors";

import { localIsoToUtcDate } from "./dateTime";
import { buildPresetReminders } from "./reminderPolicy";
import type { MaterializedItem, MaterializedReminder } from "./types";

export function materializeProposal(params: {
  proposal: PlannerActionProposal;
  userTimezone: string;
  now: Date;
}): { item: MaterializedItem; reminders: MaterializedReminder[] } {
  const { proposal, userTimezone, now } = params;

  if (proposal.intent !== "create_item") {
    throw new UserFacingError("Это действие пока нельзя сохранить как новую запись.");
  }
  if (!proposal.kind || !proposal.title?.trim()) {
    throw new UserFacingError("Не хватает названия или типа записи.");
  }

  const timezone = proposal.timezone || userTimezone;
  const startAt = proposal.startAtLocal ? localIsoToUtcDate(proposal.startAtLocal, timezone) : null;
  const dueAt = proposal.dueAtLocal ? localIsoToUtcDate(proposal.dueAtLocal, timezone) : null;
  const endAt = buildEndDate({ proposal, timezone, startAt });

  const item: MaterializedItem = {
    kind: proposal.kind,
    title: proposal.title.trim(),
    description: proposal.description,
    location: proposal.location,
    timezone,
    startAt,
    endAt,
    dueAt,
    priority: proposal.priority,
    metadata: {
      confidence: proposal.confidence,
      preparationPrompt: proposal.preparationPrompt,
      memoryCandidates: proposal.memoryCandidates,
    },
  };

  return {
    item,
    reminders: buildPresetReminders(item, now, proposal.reminderPresets),
  };
}

function buildEndDate(params: {
  proposal: PlannerActionProposal;
  timezone: string;
  startAt: Date | null;
}): Date | null {
  if (params.proposal.endAtLocal) {
    return localIsoToUtcDate(params.proposal.endAtLocal, params.timezone);
  }
  if (params.startAt && params.proposal.durationMinutes) {
    return DateTime.fromJSDate(params.startAt, { zone: "utc" })
      .plus({ minutes: params.proposal.durationMinutes })
      .toJSDate();
  }
  return null;
}
