import { DateTime } from "luxon";
import type { z } from "zod";

import {
  assistantDecisionSchema,
  type AssistantDecision,
  type OrderedTaskList,
  type TentativePlan,
  type TrainingReport,
} from "./schemas/assistantDecision";

type DecisionParams = {
  text: string;
  timezone: string;
  now?: Date;
  activeContext?: string;
};

const managementIntentPattern =
  /(дай\s+отредактир|отредактирую\s+(текущие\s+)?(задачи|дела)|покажи\s+(текущие\s+)?задач|открой\s+(текущие\s+)?(дела|задачи)|что\s+у\s+меня\s+по\s+задач|текущие\s+дела)/i;

const statusQueryPattern =
  /(что\s+у\s+меня\s+(сегодня|завтра|на\s+недел)|что\s+на\s+(сегодня|завтра)|покажи\s+(расписание|план)|план\s+на\s+(сегодня|завтра))/i;

const orderedListTriggerPattern =
  /(дела\s+по\s+порядку|план\s+на\s+сегодня|сегодня\s+нужно|дела:|по\s+порядку:|список:|на\s+сегодня\s+дела)/i;

const memoryTriggerPattern = /^(запомни|запомнить|важно)[:\s-]/i;
const correctionTriggerPattern =
  /(не\s+может\s+быть|почти\s+всегда|если\s+я\s+говорю|это\s+не\s+.+а\s+)/i;

export async function decideUserIntentWithAI(params: DecisionParams): Promise<AssistantDecision> {
  return decideUserIntentDeterministic(params);
}

export function decideUserIntentDeterministic(params: DecisionParams): AssistantDecision {
  const text = params.text.trim();
  const nowLocal = DateTime.fromJSDate(params.now ?? new Date(), { zone: "utc" }).setZone(
    params.timezone,
  );
  const orderedTasks = parseOrderedTaskList(text, nowLocal);
  if (orderedTasks) {
    return parseDecision({
      intent: "ordered_task_list",
      confidence: 0.96,
      shouldCreateItems: true,
      shouldAskConfirmation: false,
      userFacingSummary: `Понял, это список дел на день. Сохраню ${orderedTasks.items.length} пунктов отдельно и сохраню порядок.`,
      orderedTasks,
      extractedItems: orderedTasks.items.map((item) => ({
        type: item.type === "call" ? "call" : "task",
        title: item.title,
        date: orderedTasks.date,
        isFloating: true,
        sourceFragment: item.sourceFragment,
      })),
      suggestedButtons: [
        { label: "Оставить списком", action: "save_as_list" },
        { label: "Расставить время", action: "schedule_times" },
        { label: "Редактировать", action: "edit" },
      ],
    });
  }

  const trainingDecision = parseTrainingDecision(text, nowLocal);
  if (trainingDecision) return trainingDecision;

  if (managementIntentPattern.test(text)) {
    return parseDecision({
      intent: "manage_existing_items",
      confidence: 0.95,
      shouldCreateItems: false,
      shouldAskConfirmation: false,
      userFacingSummary: "Ок, ничего нового не создаю. Показываю текущие задачи для редактирования.",
      managementRequest: { target: "current", action: "edit" },
      suggestedButtons: [
        { label: "Выполнено", action: "complete" },
        { label: "Перенести", action: "reschedule" },
        { label: "Удалить", action: "delete" },
        { label: "Напомнить", action: "add_reminder" },
      ],
    });
  }

  if (isMemoryUpdate(text)) {
    return parseDecision({
      intent: "memory_update",
      confidence: 0.94,
      shouldCreateItems: false,
      shouldAskConfirmation: false,
      userFacingSummary: "Запомнил. Буду учитывать это в следующих планах.",
      memoryFacts: [buildMemoryDraft(text)],
      correctionRules: correctionTriggerPattern.test(text) ? [buildMemoryDraft(text)] : [],
    });
  }

  if (statusQueryPattern.test(text)) {
    const target = /завтра/i.test(text)
      ? "tomorrow"
      : /недел/i.test(text)
        ? "week"
        : "today";
    return parseDecision({
      intent: "status_query",
      confidence: 0.9,
      shouldCreateItems: false,
      shouldAskConfirmation: false,
      userFacingSummary: "Показываю расписание и открытые дела, ничего нового не создаю.",
      managementRequest: { target, action: "show" },
    });
  }

  return parseDecision({
    intent: "create_or_update_plan",
    confidence: 0.7,
    shouldCreateItems: true,
    shouldAskConfirmation: false,
    userFacingSummary: "Передаю сообщение в smart planner.",
  });
}

function parseOrderedTaskList(text: string, nowLocal: DateTime): OrderedTaskList | null {
  const lines = text.split(/\r?\n/);
  const items = lines
    .map((line) => line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .filter((line) => line.length > 0);

  if (items.length < 2) return null;
  if (!orderedListTriggerPattern.test(text) && !/^\s*(?:[-*•]|\d+[.)])\s+/m.test(text)) {
    return null;
  }

  const date = /завтра/i.test(text)
    ? nowLocal.plus({ days: 1 }).toISODate()
    : nowLocal.toISODate();
  if (!date) return null;

  return {
    title: /завтра/i.test(text) ? "Дела на завтра" : "Дела на сегодня",
    date,
    preserveOrder: true,
    items: items.map((title, index) => ({
      order: index + 1,
      title: normalizeListTitle(title),
      type: /созвон|звонок|колл/i.test(title) ? "call" : classifyListItem(title),
      isFloating: !/\b\d{1,2}[:.]\d{2}\b/.test(title),
      sourceFragment: title,
    })),
  };
}

function classifyListItem(title: string): "task" | "call" | "event" | "content" | "admin" {
  if (/созвон|звонок|колл/i.test(title)) return "call";
  if (/рилз|ролик|видео|пост|контент/i.test(title)) return "content";
  if (/комментатор|договор|документ|отчет|отчёт/i.test(title)) return "admin";
  return "task";
}

function parseTrainingDecision(text: string, nowLocal: DateTime): AssistantDecision | null {
  const reportsNoCycling = /(сегодня|вчера).{0,80}без\s+велик|без\s+велосипед/i.test(text);
  const hasTentativeLongRide =
    /завтра/i.test(text) && /(холм|лонг|50\s*[-–]\s*70|км|велосипед|велик)/i.test(text);
  if (!reportsNoCycling && !hasTentativeLongRide) return null;

  const reportRefs: TrainingReport["dateRefs"] = [];
  if (/сегодня/i.test(text) && /без\s+велик|без\s+велосипед/i.test(text)) {
    const date = nowLocal.toISODate();
    if (date) reportRefs.push({ date, status: "missed", summary: "Сегодня без велика" });
  }
  if (/вчера/i.test(text) && /без\s+велик|без\s+велосипед/i.test(text)) {
    const date = nowLocal.minus({ days: 1 }).toISODate();
    if (date) reportRefs.push({ date, status: "missed", summary: "Вчера без велика" });
  }

  const trainingReport = reportRefs.length
    ? {
        dateRefs: reportRefs,
        notes: "Пользователь сообщил о пропуске велотренировок.",
      }
    : undefined;

  const tentativePlan = hasTentativeLongRide ? buildTentativeTrainingPlan(text, nowLocal) : undefined;

  return parseDecision({
    intent: trainingReport ? "training_report" : "tentative_training_plan",
    confidence: 0.93,
    shouldCreateItems: true,
    shouldAskConfirmation: false,
    userFacingSummary: [
      trainingReport ? "Отмечаю пропущенные велотренировки." : null,
      tentativePlan
        ? "На завтра ставлю предварительный план тренировки без точного времени и утром спрошу, когда реально ехать."
        : null,
    ]
      .filter(Boolean)
      .join(" "),
    trainingReport,
    tentativePlan,
    extractedItems: [
      ...(trainingReport?.dateRefs.map((ref) => ({
        type: "note" as const,
        title: ref.summary,
        date: ref.date,
        isTentative: false,
        isFloating: true,
        sourceFragment: ref.summary,
      })) ?? []),
      ...(tentativePlan
        ? [
            {
              type: "training" as const,
              title: tentativePlan.title,
              date: tentativePlan.date,
              isTentative: true,
              isFloating: true,
              sourceFragment: text,
            },
          ]
        : []),
    ],
    suggestedButtons: [
      { label: "Утром", action: "choose_morning" },
      { label: "Днём", action: "choose_day" },
      { label: "Пока без времени", action: "keep_floating" },
      { label: "Отменить", action: "cancel" },
    ],
  });
}

function buildTentativeTrainingPlan(text: string, nowLocal: DateTime): TentativePlan {
  const tomorrow = nowLocal.plus({ days: 1 });
  const date = tomorrow.toISODate() ?? nowLocal.toISODate() ?? "";
  const distance = text.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*км/i);
  const title = /холм/i.test(text)
    ? `Холмы ${distance ? `${distance[1]}-${distance[2]} км` : "лонг"}`
    : distance
      ? `Лонг ${distance[1]}-${distance[2]} км`
      : "Велотренировка";

  const asksMorningDay = /утром\s*\/\s*дн[её]м|утром|дн[её]м/i.test(text);
  return {
    date,
    title,
    type: "training",
    timeWindow: asksMorningDay ? "morning_day" : "unknown",
    distanceKm: distance ? { min: Number(distance[1]), max: Number(distance[2]) } : undefined,
    intensity: /лонг/i.test(text) ? "long ride" : undefined,
    askToFinalizeAt: tomorrow
      .startOf("day")
      .plus({ hours: 8 })
      .toFormat("yyyy-MM-dd'T'HH:mm:ss"),
  };
}

function isMemoryUpdate(text: string) {
  return memoryTriggerPattern.test(text.trim()) || correctionTriggerPattern.test(text);
}

function buildMemoryDraft(text: string) {
  const content = text.replace(/^(запомни|запомнить|важно)[:\s-]*/i, "").trim();
  const nbaNight =
    /(nba|нба|сан[-\s]?антонио|оклахом|матч)/i.test(text) && /(3[:.]00|3[:.]30|03[:.]00|03[:.]30)/i.test(text);
  return {
    category: nbaNight ? "meeting_pattern" : "preference",
    content,
    searchTags: nbaNight
      ? ["NBA", "ночной эфир", "03:00", "03:30", "Москва", "Сан-Антонио", "Оклахома"]
      : [],
  };
}

function normalizeListTitle(title: string) {
  return title.replace(/\s+/g, " ").trim();
}

function parseDecision(decision: z.input<typeof assistantDecisionSchema>): AssistantDecision {
  return assistantDecisionSchema.parse(decision);
}
