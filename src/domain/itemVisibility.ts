import type { PlannerItem } from "@/db/schema";

export function isGarbageOrTestItem(
  item: Pick<PlannerItem, "title" | "description" | "metadata">,
): boolean {
  const metadata = item.metadata ?? {};
  const combinedText = `${item.title}\n${item.description ?? ""}`;
  return (
    metadata.isTest === true ||
    metadata.debug === true ||
    metadata.garbage === true ||
    metadata.command === "remindertest" ||
    metadata.source === "remindertest" ||
    metadata.garbageReason === "legacy_multiline_update_saved_as_single_event" ||
    isLegacyMultilineGarbageText(combinedText) ||
    isManagementCommandTitle(item.title) ||
    isKnownPollutedProductionTitle(item.title)
  );
}

export function isActiveItem(item: Pick<PlannerItem, "status" | "metadata" | "title" | "description">) {
  return item.status === "active" && !isGarbageOrTestItem(item);
}

export function isItemForDate(item: Pick<PlannerItem, "startAt" | "dueAt">, from: Date, to: Date) {
  const when = item.startAt ?? item.dueAt;
  return Boolean(when && when >= from && when <= to);
}

export function isVisibleInDailyDigest(
  item: Pick<PlannerItem, "status" | "metadata" | "title" | "description" | "startAt" | "dueAt">,
  from: Date,
  to: Date,
) {
  return isActiveItem(item) && isItemForDate(item, from, to);
}

export function isVisibleInEveningReview(
  item: Pick<PlannerItem, "status" | "metadata" | "title" | "description" | "startAt" | "dueAt">,
  from: Date,
  to: Date,
) {
  return isVisibleInDailyDigest(item, from, to);
}

export function isOverdueCarryCandidate(
  item: Pick<PlannerItem, "status" | "metadata" | "title" | "description" | "startAt" | "dueAt" | "kind">,
  from: Date,
  to: Date,
) {
  return (
    isActiveItem(item) &&
    item.kind !== "event" &&
    item.kind !== "recurring_task" &&
    isItemForDate(item, from, to)
  );
}

export function isLegacyMultilineGarbageText(text: string): boolean {
  const requiredFragments = [
    /созвон\s+нхл.{0,20}12[.:]00/i,
    /созвон\s+вс.{0,20}14[.:]00/i,
    /созвон\s+вм.{0,20}13[.:]00/i,
    /созвон\s+по\s+баскету.{0,20}15[.:]00/i,
    /уведомлен.{0,30}каждый\s+час/i,
  ];
  return requiredFragments.filter((pattern) => pattern.test(text)).length >= 3;
}

export function isManagementCommandTitle(title: string): boolean {
  return /^(дай\s+план|покажи\s+задачи|удалить?\s+\d|удали\s+вс[её]|очисти\s+план|сбрось\s+задачи|хочу\s+отметить\s+что\s+выполнено)/i.test(
    title.trim(),
  );
}

export function isKnownPollutedProductionTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
  return [
    /^зумы рг$/,
    /^рилзы чм$/,
    /^комментаторы нхл$/,
    /^созвон нхл$/,
    /^созвон вм$/,
    /^созвон вс$/,
    /^тестовое напоминание через \d+ мин\.?$/,
    /^jarvis rollout test reminder$/,
    /^начать настройку zoom$/,
    /^возможный созвон по коротким видео$/,
    /^велосипед z2/,
    /^еще сегодня рилзы мк$/,
    /наст(я|е|и).{0,25}мыскин/,
    /^красочный забег в 10:00$/,
    /^эфир вс в 13:00$/,
    /^тренировка z2 в 22:00$/,
    /^за час до каждого события, а после спроси как прошло, дай кнопки по удалению, переносу, редактированию каждого события отдельно$/,
  ].some((pattern) => pattern.test(normalized));
}
