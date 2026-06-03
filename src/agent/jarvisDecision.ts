import type { JarvisDecision } from "./types";

export function decideJarvisTurn(text: string): JarvisDecision {
  const normalized = normalizeText(text);

  if (isUndoRequest(normalized)) {
    return decision("undo_last_action", "debug", false, "undo_last_action", "User asked to undo the latest agent action.");
  }

  if (isCleanupRequest(normalized)) {
    return decision("cleanup_garbage", "cleanup", false, "cleanup_garbage", "User asked to clean garbage items.");
  }

  if (isDeleteByIndexRequest(normalized)) {
    return decision(
      "delete_by_indices",
      "manage",
      false,
      "delete_items_by_indices",
      "User asked to delete items by display indices.",
    );
  }

  if (isDoneByIndexRequest(normalized)) {
    return decision(
      "mark_done_by_indices",
      "manage",
      false,
      "mark_done_by_indices",
      "User asked to mark displayed items done.",
    );
  }

  if (isYesterdayReviewRequest(normalized)) {
    return decision(
      "render_yesterday_review",
      "review",
      false,
      "render_yesterday_review",
      "User asked to review yesterday instead of creating a new task.",
    );
  }

  if (isEveningReviewRequest(normalized)) {
    return decision(
      "render_evening_review",
      "review",
      false,
      "render_evening_review",
      "User asked for an evening review.",
    );
  }

  if (isFullPlanRequest(normalized)) {
    return decision(
      "render_full_plan",
      "answer",
      false,
      "render_schedule_view",
      "User asked to see the full plan.",
    );
  }

  if (isTomorrowRequest(normalized)) {
    return decision(
      "render_tomorrow",
      "answer",
      false,
      "render_schedule_view",
      "User asked for tomorrow's schedule.",
    );
  }

  if (isWeekRequest(normalized)) {
    return decision(
      "render_week",
      "answer",
      false,
      "render_schedule_view",
      "User asked for the week schedule.",
    );
  }

  if (isTodayRequest(normalized)) {
    return decision(
      "render_today",
      "answer",
      false,
      "render_schedule_view",
      "User asked for today's schedule.",
    );
  }

  if (isTaskViewRequest(normalized)) {
    return decision(
      "render_tasks",
      "manage",
      false,
      "render_task_view",
      "User asked to see current manageable tasks.",
    );
  }

  return {
    intent: "delegate_to_planner",
    mode: "capture",
    confidence: 0.55,
    shouldCreateItems: true,
    toolName: null,
    reason: "No Jarvis management intent matched; delegate to the existing V2 planner.",
  };
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

function isFullPlanRequest(text: string) {
  return /(дай|покажи|открой|выведи).{0,20}(план|список).{0,20}(целиком|полностью|весь|общий)/i.test(text);
}

function isTodayRequest(text: string) {
  return /(что|план|расписание).{0,20}(сегодня)|сегодняшний план/i.test(text);
}

function isTomorrowRequest(text: string) {
  return /(что|план|расписание).{0,20}(завтра)|завтрашний план/i.test(text);
}

function isWeekRequest(text: string) {
  return /(что|план|расписание).{0,20}(недел|7 дней)|ближайшие 7/i.test(text);
}

function isTaskViewRequest(text: string) {
  return /(покажи|открой|дай).{0,30}(текущие )?(задачи|дела)|что у меня по задачам|редактир.*задач/i.test(text);
}

function isYesterdayReviewRequest(text: string) {
  return /(отметить|разобрать|проверить|ревью|обзор).{0,40}(выполнено|сделано|вчера)|что выполнено вчера|вчерашний разбор/i.test(
    text,
  );
}

function isEveningReviewRequest(text: string) {
  return /(вечерний|вечером).{0,20}(обзор|разбор|проверка)|подведи итоги/i.test(text);
}

function isCleanupRequest(text: string) {
  return /(почисти|убери|удали).{0,30}(мусор|тестов|лишн|случайн)|cleanup garbage|garbage cleanup/i.test(text);
}

function isDeleteByIndexRequest(text: string) {
  return /(удали|удалить|убери|отмени|стереть)/i.test(text) && /\d/.test(text);
}

function isDoneByIndexRequest(text: string) {
  return /(готово|сделано|выполнено|отметь|отметить|закрой)/i.test(text) && /\d/.test(text);
}

function isUndoRequest(text: string) {
  return /^(undo|откат|отмени последнее|верни как было|назад)/i.test(text);
}
