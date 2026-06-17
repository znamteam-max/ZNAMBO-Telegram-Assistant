export const RELEASE_NOTES = {
  version: "2.21.0",
  previousVersion: "2.20.0",
  title: "Plan visual semantics, owner timezone and multi-event reminder fix",
  bullets: [
    "закрепил owner timezone Europe/Moscow для natural-language планирования, вывода и /admin_time_debug",
    "обновил /plan: одна компактная строка напоминаний на пункт, ⏰ для сегодняшнего и ↻ для долгосрочных правил",
    "сделал event follow-up reminder-only записи видимыми в карточке события и сегодняшнем плане",
    "добавил multi-event reminder template для двух визитов к ортодонту с человеческими offset labels",
    "усилил monthly day-range audit и добавил /admin_repair_v2210 preview|apply",
  ],
  testPrompts: [
    "/dashboard",
    "/admin_time_debug",
    "Концерт Вадима Постильного в пятницу в 21.30 в Большевик Лофт",
    "Повторные два прихода с Робом к ортодонту сначала 1 июля в 19.00 и 2 июля в 11.45, напомни про пару этих визитов за неделю, за 3 дня, за 2 дня, и утром в эти дни много раз",
    "/dashboard",
    "/admin_repair_v2210 preview",
  ],
} as const;

export function normalizeReleaseVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

export function displayReleaseVersion(version: string): string {
  return `V${normalizeReleaseVersion(version)}`;
}

export function shortCommit(commitSha: string | null | undefined): string {
  return commitSha?.trim() ? commitSha.trim().slice(0, 8) : "unknown";
}
