export const RELEASE_NOTES = {
  version: "2.25.0",
  previousVersion: "2.24.0",
  title: "In-place re-nag, loud delivery and end-of-day semantics",
  bullets: [
    "re-nag карточки сначала редактируют текущую active card и не плодят цепочку одинаковых сообщений",
    "reminder/re-nag отправка явно использует loud delivery: disable_notification=false и безопасный audit send-mode",
    "кнопка До завтра для until-done/carryover подавляет остаток дня и возвращает напоминания завтра в 08:00",
    "pinned car note больше не показывается в Сегодня — напоминания, а V2.25 repair отменяет случайные car policies",
    "before-event labels больше не показывают технические 645 минут / 165 минут / 168 ч",
    "добавлены /admin_repair_v2250 preview|apply и protected V2.25 production smokes",
  ],
  testPrompts: [
    "/admin_repair_v2250 preview",
    "/dashboard",
    "/admin_repair_v2250 apply",
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
