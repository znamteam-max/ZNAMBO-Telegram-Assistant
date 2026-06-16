export const RELEASE_NOTES = {
  version: "2.16.0",
  previousVersion: "2.15.0",
  title: "Reminder session routing and calendar feedback hardening",
  bullets: [
    "отдельная session routing ветка для нескольких напоминаний перед событием",
    "same-message event+reminders and follow-up reminder attachment",
    "локальное подтверждение изменений перед calendar sync status",
    "history/important cleanup and /admin_repair_v2160",
  ],
  testPrompts: ["/plan", "В 7.00 и 7.30", "/admin_repair_v2160 preview"],
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
