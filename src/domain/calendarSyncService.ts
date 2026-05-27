import type { PlannerItem } from "@/db/schema";

export async function syncCalendarAfterLocalCommit(params: {
  item: PlannerItem;
  sync: (item: PlannerItem) => Promise<{ status: string; externalId?: string }>;
  recordError: (item: PlannerItem, error: string) => Promise<void>;
}) {
  try {
    return await params.sync(params.item);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.recordError(params.item, message);
    return { status: "error" as const, item: params.item, error: message };
  }
}
