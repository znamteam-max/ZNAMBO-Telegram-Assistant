export type HardManagementIntent =
  | { intent: "reset_active_plan"; mode: "all" }
  | { intent: "render_recent_range"; days: number; includeToday: true }
  | { intent: "render_full_plan" }
  | { intent: "render_today" }
  | { intent: "render_tomorrow" }
  | { intent: "render_week" }
  | { intent: "render_tasks" }
  | { intent: "render_yesterday_review" }
  | { intent: "render_evening_review" }
  | { intent: "cleanup_garbage" }
  | { intent: "delete_by_indices" }
  | { intent: "mark_done_by_indices" }
  | { intent: "reschedule_by_indices" };

export function detectHardManagementIntent(text: string): HardManagementIntent | null {
  const normalized = normalizeManagementText(text);

  if (
    /(удали|удалить|очисти|сбрось).{0,30}(все|всё|активн(ый|ого)? план|текущ(ие|ий) задач)|начн(е|ё)м заново|с чистого листа/i.test(
      normalized,
    )
  ) {
    return { intent: "reset_active_plan", mode: "all" };
  }

  const recentDays = normalized.match(
    /(дай|покажи|открой).{0,25}(план|дела|задачи).{0,25}(за последние|последние)\s+(\d{1,2})\s+дн/i,
  );
  if (recentDays) {
    return {
      intent: "render_recent_range",
      days: Math.max(1, Math.min(14, Number(recentDays[4]) || 2)),
      includeToday: true,
    };
  }

  if (/(дай|покажи|открой|выведи).{0,25}(план|список).{0,25}(целиком|полностью|весь|общий)/i.test(normalized)) {
    return { intent: "render_full_plan" };
  }
  if (/^(дай|покажи|открой)\s+план$/i.test(normalized)) return { intent: "render_full_plan" };
  if (/(что|план|расписание).{0,20}(сегодня)|сегодняшний план/i.test(normalized)) {
    return { intent: "render_today" };
  }
  if (/(что|план|расписание).{0,20}(завтра)|завтрашний план/i.test(normalized)) {
    return { intent: "render_tomorrow" };
  }
  if (/(что|план|расписание).{0,20}(недел|7 дней)|ближайшие 7/i.test(normalized)) {
    return { intent: "render_week" };
  }
  if (
    /(покажи|открой|дай).{0,30}(текущие )?(задачи|дела)|что у меня по задачам|редактир.*задач/i.test(
      normalized,
    )
  ) {
    return { intent: "render_tasks" };
  }
  if (
    /(хочу\s+)?(отметить|разобрать|проверить|ревью|обзор).{0,50}(выполнено|сделано|вчера)|что выполнено вчера|вчерашний разбор/i.test(
      normalized,
    )
  ) {
    return { intent: "render_yesterday_review" };
  }
  if (/(вечерний|вечером).{0,20}(обзор|разбор|проверка)|подведи итоги/i.test(normalized)) {
    return { intent: "render_evening_review" };
  }
  if (/(почисти|убери|удали|очисти).{0,30}(мусор|тестов|лишн|случайн)|cleanup garbage|garbage cleanup/i.test(normalized)) {
    return { intent: "cleanup_garbage" };
  }
  if (/(удали|удалить|убери|отмени|стереть)/i.test(normalized) && /\d/.test(normalized)) {
    return { intent: "delete_by_indices" };
  }
  if (/(готово|сделано|выполнено|отметь|отметить|закрой)/i.test(normalized) && /\d/.test(normalized)) {
    return { intent: "mark_done_by_indices" };
  }
  if (/(перенеси|перенести|отложи|отложить)/i.test(normalized) && /\d/.test(normalized)) {
    return { intent: "reschedule_by_indices" };
  }

  return null;
}

export function isHardManagementText(text: string): boolean {
  return detectHardManagementIntent(text) !== null;
}

export function normalizeManagementText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"]/g, "")
    .replace(/\s+/g, " ");
}

export const SAFE_MANAGEMENT_FALLBACK_REPLY =
  "Понял, это команда управления, а не новая задача. Ничего не создаю.";
