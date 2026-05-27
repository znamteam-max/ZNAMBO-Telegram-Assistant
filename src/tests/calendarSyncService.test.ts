import { describe, expect, it, vi } from "vitest";

import { syncCalendarAfterLocalCommit } from "@/domain/calendarSyncService";
import type { PlannerItem } from "@/db/schema";

describe("calendar sync failure", () => {
  it("preserves the local item and records sync error", async () => {
    const item = {
      id: "item-1",
      userId: "user-1",
      title: "Встреча",
      kind: "event",
      startAt: new Date("2026-05-28T09:00:00.000Z"),
    } as PlannerItem;
    const recordError = vi.fn(async () => undefined);

    const result = await syncCalendarAfterLocalCommit({
      item,
      sync: async () => {
        throw new Error("Google unavailable");
      },
      recordError,
    });

    expect(result.status).toBe("error");
    expect("item" in result ? result.item.id : null).toBe("item-1");
    expect(recordError).toHaveBeenCalledWith(item, "Google unavailable");
  });
});
