const LEADING_COMMANDS = [
  /^(?:пожалуйста\s+)?напомни(?:\s+мне)?\s+/i,
  /^(?:пожалуйста\s+)?напоминай(?:\s+мне)?\s+/i,
  /^напоминать(?:\s+мне)?\s+/i,
  /^нужно\s+/i,
  /^надо\s+/i,
  /^запиши\s+/i,
  /^добавь\s+/i,
  /^создай\s+/i,
  /^у\s+меня\s+/i,
];

const POLICY_BOUNDARIES = [
  /[.!?]\s*напоминай(?:\s+мне)?(?=\s|$|[,.;:!?])/i,
  /[.!?]\s*напоминать(?=\s|$|[,.;:!?])/i,
  /[.!?]\s*напомни(?:\s+мне)?(?=\s|$|[,.;:!?])/i,
  /[.!?]\s*предупреди(?:\s+меня)?(?=\s|$|[,.;:!?])/i,
  /[,;]\s*напоминай(?:\s+мне)?(?=\s|$|[,.;:!?])/i,
  /[,;]\s*напоминать(?=\s|$|[,.;:!?])/i,
  /[,;]\s*напомни(?:\s+мне)?(?=\s|$|[,.;:!?])/i,
  /[,;]\s*предупреди(?:\s+меня)?(?=\s|$|[,.;:!?])/i,
  /\s+кажд(?:ый|ые|ую)\s+(?:час|часа|часов|день|недел|полчаса|\d+\s*мин)/i,
  /\s+до\s+конца\s+дня(?=\s|$|[,.;:!?])/i,
  /\s+пока\s+(?:я\s+)?не\s+(?:отмечу|сделаю|выполню|подтвержу)(?=\s|$|[,.;:!?])/i,
  /\s+пинай(?=\s|$|[,.;:!?])/i,
];

const TEMPORAL_PREFIX = /^(?:сегодня|завтра|послезавтра)\s+/i;
const FINAL_CORRECTED_EVENT =
  /(?:^|,\s*)((?:созвон|встреча|эфир|тренировка|прием|визит)\s+по\s+[^,.;!?]+)\s*$/i;

export function sanitizePlannerTitle(value: string) {
  let title = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!title) return title;

  for (const pattern of LEADING_COMMANDS) {
    title = title.replace(pattern, "").trim();
  }
  title = title.replace(TEMPORAL_PREFIX, "").trim();

  let boundaryIndex = -1;
  for (const pattern of POLICY_BOUNDARIES) {
    const match = title.match(pattern);
    if (match?.index !== undefined) {
      boundaryIndex = boundaryIndex < 0 ? match.index : Math.min(boundaryIndex, match.index);
    }
  }
  if (boundaryIndex >= 0) title = title.slice(0, boundaryIndex).trim();

  // Spoken corrections often repeat the final intended event after "нет, не по X, по Y".
  // Only collapse when that explicit correction marker is present, so ordinary negations
  // and titles that merely contain commas remain untouched.
  if (/\bнет\s*,?\s*не\s+по\b/i.test(title)) {
    const corrected = title.match(FINAL_CORRECTED_EVENT)?.[1];
    if (corrected) title = corrected.trim();
  }

  title = title
    .replace(/\s+(?:сегодня|завтра|послезавтра)$/i, "")
    .replace(/[.,;:!?]+$/g, "")
    .replace(/^[\s:.,;!?-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return capitalizeFirstLetter(title);
}

export function capitalizeFirstLetter(value: string) {
  return value.replace(/^(\p{Ll})/u, (match) => match.toLocaleUpperCase("ru"));
}
