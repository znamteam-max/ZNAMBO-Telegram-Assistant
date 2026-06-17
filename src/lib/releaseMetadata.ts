export const RELEASE_NOTES = {
  version: "2.22.0",
  previousVersion: "2.21.0",
  title: "Session escape, interval-window reminders and recurring card UX fix",
  bullets: [
    "добавил session escape: новое самостоятельное interval-window reminder больше не захватывается старой recurring card/session; owner timezone Europe/Moscow сохранен для вывода",
    "создаю один finite interval-window reminder item plus policy для окон вроде завтра 06:00-07:30 каждые 10 минут",
    "закрепил morning window parsing: 6 до 7.30 означает 06:00-07:30 Europe/Moscow, не вечернее окно",
    "обновил recurring reminder card UX: явные кнопки Выполнено сейчас, Через 30 мин, Через 1 час, Через 2 часа, Завтра, Изменить правило, Остановить правило",
    "добавил calendar-safe /admin_repair_v2220 preview|apply и protected v2220 repair actions",
  ],
  testPrompts: [
    "/dashboard",
    "/admin_repair_v2220 preview",
    "Завтра с 6 до 7.30 напоминай мне каждые 10 минут взять с собой спицы",
    "/dashboard",
    "/admin_repair_v2220 apply",
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
