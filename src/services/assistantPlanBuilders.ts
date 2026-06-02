import { DateTime } from "luxon";

import type { ActionPlan, ActionPlanItem } from "@/ai/schemas";
import type { AssistantDecision } from "@/ai/schemas/assistantDecision";
import { validateActionPlan } from "@/ai/plan-validator";

export function buildActionPlanFromDecision(params: {
  decision: AssistantDecision;
  text: string;
  timezone: string;
  now: Date;
}): ActionPlan | null {
  if (params.decision.intent === "ordered_task_list" && params.decision.orderedTasks) {
    return validateActionPlan({
      plan: buildOrderedTaskActionPlan(params.decision),
      text: params.text,
      timezone: params.timezone,
      now: params.now,
    });
  }

  if (
    (params.decision.intent === "training_report" ||
      params.decision.intent === "tentative_training_plan") &&
    (params.decision.trainingReport || params.decision.tentativePlan)
  ) {
    return validateActionPlan({
      plan: buildTrainingActionPlan(params.decision, params.timezone),
      text: params.text,
      timezone: params.timezone,
      now: params.now,
    });
  }

  return null;
}

function buildOrderedTaskActionPlan(decision: AssistantDecision): ActionPlan {
  const ordered = decision.orderedTasks;
  if (!ordered) throw new Error("orderedTasks missing");
  const dueAtLocal = `${ordered.date}T23:59:00`;
  return {
    intent: "plan",
    summary: `Список дел на день: ${ordered.items.length} пунктов`,
    reply: null,
    confidence: decision.confidence,
    requiresConfirmation: false,
    memoryCandidates: [],
    clarificationQuestions: [],
    actions: ordered.items.map((item): ActionPlanItem => {
      const itemType = item.type === "call" ? "call" : item.type;
      return {
        actionType: "task",
        kind: "task",
        title: item.title,
        description: item.type === "call" ? "Созвон без точного времени." : null,
        location: null,
        timezone: null,
        startAtLocal: null,
        endAtLocal: null,
        dueAtLocal,
        durationMinutes: null,
        priority: 3,
        confidence: 0.94,
        risk: "low",
        requiresConfirmation: false,
        tentative: false,
        recurrence: null,
        reminders: [],
        memoryCandidates: [],
        metadata: {
          listTitle: ordered.title,
          listDate: ordered.date,
          orderIndex: item.order,
          isFloating: item.isFloating,
          itemType,
          preserveOrder: ordered.preserveOrder,
          sourceFragment: item.sourceFragment,
        },
      };
    }),
  };
}

function buildTrainingActionPlan(decision: AssistantDecision, timezone: string): ActionPlan {
  const actions: ActionPlanItem[] = [];

  for (const report of decision.trainingReport?.dateRefs ?? []) {
    actions.push({
      actionType: "note",
      kind: "note",
      title: report.summary,
      description: "Тренировочный отчёт: пропуск велотренировки.",
      location: null,
      timezone,
      startAtLocal: null,
      endAtLocal: null,
      dueAtLocal: `${report.date}T23:59:00`,
      durationMinutes: null,
      priority: 4,
      confidence: 0.95,
      risk: "low",
      requiresConfirmation: false,
      tentative: false,
      recurrence: null,
      reminders: [],
      memoryCandidates: [],
      metadata: {
        trainingReport: true,
        trainingStatus: report.status,
        trainingDiscipline: "cycling",
        reportDate: report.date,
      },
    });
  }

  const tentative = decision.tentativePlan;
  if (tentative) {
    const askAt = tentative.askToFinalizeAt ?? `${tentative.date}T08:00:00`;
    const eveningFollowup = DateTime.fromISO(`${tentative.date}T20:00:00`, { zone: timezone }).toFormat(
      "yyyy-MM-dd'T'HH:mm:ss",
    );
    actions.push({
      actionType: "training",
      kind: "training",
      title: tentative.title,
      description: buildTentativeTrainingDescription(decision),
      location: /холм/i.test(tentative.title) ? "Холмы" : null,
      timezone,
      startAtLocal: null,
      endAtLocal: null,
      dueAtLocal: askAt,
      durationMinutes: null,
      priority: 3,
      confidence: 0.9,
      risk: "medium",
      requiresConfirmation: false,
      tentative: true,
      recurrence: null,
      reminders: [
        {
          type: "custom",
          scheduledAtLocal: askAt,
          offsetMinutesBefore: null,
          repeatUntilAck: false,
          payload: {
            prompt: "Когда реально поедешь на велотренировку?",
            buttons: ["morning", "day", "keep_floating", "cancel"],
          },
        },
        {
          type: "training_followup",
          scheduledAtLocal: eveningFollowup,
          offsetMinutesBefore: null,
          repeatUntilAck: false,
          payload: { prompt: "Как прошёл лонг и какие ощущения?" },
        },
      ],
      memoryCandidates: [],
      metadata: {
        tentativeTrainingPlan: true,
        tentative: true,
        timeWindow: tentative.timeWindow,
        timeUnspecified: true,
        askToFinalizeAt: askAt,
        distanceKm: tentative.distanceKm,
        intensity: tentative.intensity,
        trainingType: "cycling_long_ride",
      },
    });
  }

  return {
    intent: "plan",
    summary: decision.userFacingSummary,
    reply: null,
    confidence: decision.confidence,
    requiresConfirmation: false,
    actions,
    memoryCandidates: [],
    clarificationQuestions: [],
  };
}

function buildTentativeTrainingDescription(decision: AssistantDecision) {
  const plan = decision.tentativePlan;
  if (!plan) return null;
  const distance = plan.distanceKm
    ? `${plan.distanceKm.min ?? ""}-${plan.distanceKm.max ?? ""} км`.replace(/^-|-$/g, "")
    : null;
  const windowLabel =
    plan.timeWindow === "morning_day"
      ? "утром/днём, точное время не выбрано"
      : plan.timeWindow === "unknown"
        ? "точное время не выбрано"
        : plan.timeWindow;
  return [distance ? `Дистанция: ${distance}.` : null, `Окно: ${windowLabel}.`]
    .filter(Boolean)
    .join(" ");
}
