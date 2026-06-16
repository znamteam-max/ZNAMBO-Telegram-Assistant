export const RELEASE_NOTES = {
  version: "2.17.0",
  previousVersion: "2.16.0",
  title: "Target choice, reminder offset hygiene and past event review",
  bullets: [
    "похожие события в том же слоте больше не обновляются молча — сначала показываю выбор цели",
    "event + reminder updates отвечают одним локальным результатом без generic success-then-failure",
    "before-event reminders рендерятся deduped: без дублей и без generic «один раз»",
    "прошедшие важные события уходят в «Прошло — решить» с явными действиями",
  ],
  testPrompts: [
    "Созвон с Винлайном по ЦП завтра в 15.30. Напомни мне за два часа и за полчаса",
    "За 3 часа, за 2 часа, за час",
    "/admin_repair_v2170 preview",
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
