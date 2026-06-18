export const RELEASE_NOTES = {
  version: "2.23.0",
  previousVersion: "2.22.0",
  title: "Creation intent priority, pinned context notes, re-nag and human labels fix",
  bullets: [
    "новые scheduled creation intents с явным временем и напоминаниями создают новое событие, а не уходят в reminder-target-resolution",
    "negative reminder intent вроде «без напоминаний» создаёт событие без reminder policies и без уточняющей сессии",
    "добавлены закреплённые контекстные заметки: машина/ключи/отдельные заметки живут отдельно от задач, видны в плане и отвечают на вопросы",
    "action-required reminder cards регистрируют DB-backed re-nag prompt и повторяются каждые 5 минут до ответа/отмены/истечения",
    "dashboard и reminder labels больше не показывают технические 168 ч / 72 ч / 645 минут; future dated items идут в «Позже», carryover until-done — в «Не закрыто со вчера»",
    "добавлены calendar-safe /admin_repair_v2230 preview|apply и protected v2230 pinned context smoke",
  ],
  testPrompts: [
    "/dashboard",
    "/admin_repair_v2230 preview",
    "Массаж в 15.30, напомни за час и за полчаса до",
    "Эфир шоу Централь Парк завтра с 10.00 до 11.00, без напоминаний",
    "Отдельное напоминание: машину оставил на парковке за ВкусВиллом",
    "/dashboard",
    "/admin_repair_v2230 apply",
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
