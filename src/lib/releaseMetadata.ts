export const RELEASE_NOTES = {
  version: "2.19.0",
  previousVersion: "2.18.0",
  title: "Today until-done task due date and policy audit fix",
  bullets: [
    "исправил сценарий «сегодня + пока не сделаю»: задача получает дедлайн сегодня 23:59",
    "исправил окно until-done policy: в интерфейсе показывается 23:59, а не UTC-сдвиг",
    "закрепил today until-done задачи в разделе «Сегодня — задачи», включая snooze-состояние",
    "добавил /admin_repair_v2190 preview|apply для аудита policiesMissingNextReminder",
  ],
  testPrompts: [
    "Напомни мне сегодня проверить билеты на концерт Вадима Постильного. Напоминай до тех пор, пока я это не сделаю сегодня.",
    "/dashboard",
    "/admin_repair_v2190 preview",
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
