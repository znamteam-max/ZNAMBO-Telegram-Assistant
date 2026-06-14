import type { PlannerItem } from "@/db/schema";

export type PersistentMarkerMode = "auto" | "show" | "hide";

export function getPersistentMarkerMode(item: PlannerItem): PersistentMarkerMode {
  const mode = item.metadata?.persistentMarkerMode;
  return mode === "show" || mode === "hide" ? mode : "auto";
}

export function shouldShowPersistentMarker(params: {
  item: PlannerItem;
  hasPersistentPolicy: boolean;
}) {
  const mode = getPersistentMarkerMode(params.item);
  if (mode === "show") return true;
  if (mode === "hide") return false;
  return params.hasPersistentPolicy;
}
