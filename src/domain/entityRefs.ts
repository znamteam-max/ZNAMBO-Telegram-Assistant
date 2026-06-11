export type EntityRefType =
  | "planner_item"
  | "reminder_policy"
  | "campaign"
  | "campaign_item"
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
  return `entity:open:${ref.type}:${ref.id}`;
}
