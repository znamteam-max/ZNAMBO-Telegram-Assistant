export type EntityRefType =
  | "planner_item"
  | "reminder_policy"
  | "campaign"
  | "campaign_item"
  | "external_calendar_event"
  | "history_item"
  | "legacy_orphan";

export type EntityRef = {
  type: EntityRefType;
  id: string;
};

export function plannerItemRef(id: string): EntityRef {
  return { type: "planner_item", id };
}

export function entityRefCallback(ref: EntityRef) {
  const type = ref.type === "external_calendar_event" ? "external" : ref.type;
  return `entity:open:${type}:${ref.id}`;
}
