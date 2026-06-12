import type { TimelineEntry } from "./timelineClassification";

export type ImportanceMode = "none" | "auto" | "manual" | "ask_later";

export function importanceMode(entry: TimelineEntry): ImportanceMode {
  const value = entry.policy?.metadata?.importanceMode ?? entry.item?.metadata?.importanceMode;
  return ["none", "auto", "manual", "ask_later"].includes(String(value))
    ? (value as ImportanceMode)
    : "auto";
}

export function importanceLabel(priority: number) {
  return {
    1: "Низкая",
    2: "Ниже обычной",
    3: "Обычная",
    4: "Важная",
    5: "Очень важная",
  }[clampPriority(priority)];
}

export function importanceMarker(priority: number) {
  const value = clampPriority(priority);
  if (value === 5) return "🔥 Очень важно";
  if (value === 4) return "⭐ Важно";
  return "";
}

export function visibleImportanceMarker(entry: TimelineEntry) {
  if (importanceMode(entry) !== "manual") return "";
  return importanceMarker(entry.item?.priority ?? Number(entry.policy?.metadata?.basePriority ?? 3));
}

export function visibleImportanceLabel(entry: TimelineEntry) {
  const mode = importanceMode(entry);
  if (mode === "none") return "Без значка";
  if (mode === "auto") return "Авто";
  if (mode === "ask_later") return "Уточнить позже";
  return importanceLabel(entry.item?.priority ?? Number(entry.policy?.metadata?.basePriority ?? 3));
}

export function urgencyExplanation(boost: number) {
  if (boost >= 2) return "срочность повышена: время наступило или осталось до 3 часов";
  if (boost === 1) return "срочность повышена: осталось менее суток";
  return "без временного повышения";
}

function clampPriority(value: number) {
  return Math.max(1, Math.min(5, Math.round(value)));
}
