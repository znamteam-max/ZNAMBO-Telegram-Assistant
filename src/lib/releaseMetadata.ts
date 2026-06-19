export const RELEASE_NOTES = {
  version: "2.26.0",
  previousVersion: "2.25.0",
  title: "Reminder stack, dashboard sound policy, weekday parsing and visit template",
  bullets: [
    "каждый 5-минутный re-nag отправляет одну новую громкую карточку и удаляет предыдущую, не создавая видимый стек",
    "message_not_modified считается успешным no-op, а недоступное удаление переводит цель в безопасный edit-only режим",
    "центральная sound policy делает reminder/re-nag/event громкими, а dashboard/status/debug/release — тихими",
    "явное В понедельник в 12:00 создаёт будущий startAt и не превращается в просроченный дедлайн",
    "пара визитов к ортодонту получает канонический шаблон: неделя, 3 дня, утро, 2 часа и 30 минут",
    "добавлены /admin_repair_v2260 preview|apply и protected V2.26 production smokes",
  ],
  testPrompts: ["/admin_repair_v2260 preview", "/dashboard", "/admin_repair_v2260 apply"],
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
