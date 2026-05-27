import { describe, expect, it } from "vitest";

import { sortPlannerItemsForAgenda } from "@/domain/digestService";

describe("digest ordering", () => {
  it("orders meetings, trainings and tasks by their effective time", () => {
    const createdAt = new Date("2026-05-26T00:00:00.000Z");
    const sorted = sortPlannerItemsForAgenda([
      {
        kind: "task",
        title: "Task",
        dueAt: new Date("2026-05-26T15:00:00.000Z"),
        startAt: null,
        createdAt,
      },
      {
        kind: "event",
        title: "Meeting",
        startAt: new Date("2026-05-26T09:00:00.000Z"),
        dueAt: null,
        createdAt,
      },
      {
        kind: "training",
        title: "Training",
        startAt: new Date("2026-05-26T12:00:00.000Z"),
        dueAt: null,
        createdAt,
      },
    ]);

    expect(sorted.map((item) => item.kind)).toEqual(["event", "training", "task"]);
  });
});
