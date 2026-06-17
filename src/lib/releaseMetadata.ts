export const RELEASE_NOTES = {
  version: "2.18.0",
  previousVersion: "2.17.0",
  title: "Release encoding, overlap target choice and deterministic reminder setup",
  bullets: [
    "исправил выбор похожих событий и созвонов",
    "исправил напоминания до события: за 2 часа, за час, за 30 минут",
    "исправил кнопки и сценарии «пока не сделаю»",
    "развёл совпадающие напоминания, чтобы они не приходили потоком",
  ],
  testPrompts: [
    "Созвон с Винлайном по ЦП завтра в 15.30. Напомни мне за два часа и за полчаса",
    "За 3 часа, за 2 часа, за час",
    "/admin_repair_v2180 preview",
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
