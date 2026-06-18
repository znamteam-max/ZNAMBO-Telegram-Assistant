export const RELEASE_NOTES = {
  version: "2.24.0",
  previousVersion: "2.23.0",
  title: "Actionable re-nag, pinned-note repair and carryover reminder cards",
  bullets: [
    "actionable re-nag cards заново собираются из актуального item/policy/reminder state и приходят с рабочими inline-кнопками",
    "стандартная карточка поддерживает Сделал, 30 минут, 1 час, 2 часа, 4 часа и До конца дня с учетом finite policy window",
    "policy snooze создает отдельное отложенное срабатывание и останавливает re-nag до нового времени",
    "закрепленные заметки о машине создаются и обновляются раньше date parsing, без reminder policy и календарной синхронизации",
    "carryover until-done задачи получают сегодняшнее активное окно, а monthly day-range карточки показывают occurrence и правило без текста «без времени»",
    "monthly audit получил durable throttling, /actionlog сворачивает исторические дубли",
    "open-ended каждый час до выполнения стартует из ближайшего безопасного слота без ложного missing-time draft",
    "добавлены calendar-safe /admin_repair_v2240 preview|apply и protected V2.24 production smokes",
  ],
  testPrompts: [
    "/admin_repair_v2240 preview",
    "Запомни где машина: за ВкусВиллом, ближе к клинике Рошаля.",
    "Где машина?",
    "/dashboard",
    "/admin_repair_v2240 apply",
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
