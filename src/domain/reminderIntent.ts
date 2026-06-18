export function hasNegativeReminderIntent(text: string) {
  const normalized = normalizeRu(text);
  return (
    /без\s+(?:напоминаний|уведомлений)(?=\s|$|[,.;:!?])/i.test(normalized) ||
    /(?:напоминания|уведомления)\s+не\s+нужны(?=\s|$|[,.;:!?])/i.test(normalized) ||
    /не\s+напоминай(?=\s|$|[,.;:!?])/i.test(normalized) ||
    /не\s+надо\s+(?:напоминать|уведомлять)(?=\s|$|[,.;:!?])/i.test(normalized)
  );
}

export function hasPositiveReminderIntent(text: string) {
  const normalized = normalizeRu(text);
  if (hasNegativeReminderIntent(normalized)) return false;
  return /(напомн|напоминан|уведом|за\s+(?:час|полчаса|\d+\s*(?:мин|ч)|день|недел))/i.test(
    normalized,
  );
}

export function isTechnicalBeforeEventLabel(value: string) {
  const normalized = normalizeRu(value);
  return /^за\s+\d+\s*(?:ч|час(?:а|ов)?|мин(?:ут)?)/i.test(normalized);
}

function normalizeRu(value: string) {
  return String(value ?? "")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}
