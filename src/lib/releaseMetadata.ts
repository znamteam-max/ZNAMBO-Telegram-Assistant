export const RELEASE_NOTES = {
  version: "2.20.0",
  previousVersion: "2.19.0",
  title: "Plan rendering, daily policy, event follow-up and button safety fix",
  bullets: [
    "сделал /plan компактнее: жирные номера, короткие строки Сегодня/Правило и без повторяющихся колокольчиков",
    "скрыл фоновые post-event follow-up policies из обычного плана, оставив их в карточке или отдельном actionable-блоке",
    "починил daily recurring без времени: бот создаёт draft-уточнение вместо внутренней ошибки",
    "укоротил опасные Telegram callback payloads и добавил /admin_repair_v2200 preview|apply",
  ],
  testPrompts: [
    "/dashboard",
    "Каждый день напоминай мне решить вопрос с ЭЦП",
    "/dashboard",
    "/admin_repair_v2200 preview",
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
