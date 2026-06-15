export const RELEASE_NOTES = {
  version: "2.15.0",
  previousVersion: "2.14.0",
  title: "Release notification and deploy completion",
  bullets: [
    "уведомление владельца после завершённого production-релиза",
    "защита от повторной отправки для одной версии и commit",
    "команды /version, /release_notes и /release_notify",
  ],
  testPrompts: ["/version", "/plan", "/actionlog"],
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
