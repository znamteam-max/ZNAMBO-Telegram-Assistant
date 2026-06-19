export const RELEASE_NOTES = {
  version: "2.27.0",
  previousVersion: "2.26.0",
  title: "Until-done phrase order and action plan guard fix",
  bullets: [
    "фразы вида «починить кран … до тех пор, когда не сделаю, каждый час» теперь детерминированно становятся nag_until_ack",
    "исходный текст выигрывает у плохого AI-предложения recurring/task без времени",
    "pending preview больше не показывает «без времени», если в исходной фразе есть cadence + until-done",
    "guard безопасно стартует open-ended nag_until_ack от now/nearest safe slot вместо missing_initial_fire",
    "добавлены безопасные audit-события и protected V2.27 smokes",
    "добавлен /admin_repair_v2270 preview|apply без изменений Yandex Calendar и без автосоздания реальных задач",
  ],
  testPrompts: [
    "Напоминай мне починить кран в ванной до тех пор, когда не сделаю, каждый час",
    "/admin_repair_v2270 preview",
    "/admin_repair_v2270 apply",
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
