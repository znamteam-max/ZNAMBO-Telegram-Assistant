import { describe, expect, it, vi } from "vitest";

import type { PlannerItem } from "@/db/schema";

const mocks = vi.hoisted(() => ({
  rememberTaskView: vi.fn().mockResolvedValue({ id: "view-id" }),
}));

vi.mock("@/agent/state/taskViewState", () => ({
  rememberTaskView: mocks.rememberTaskView,
}));

import { renderAndSaveTaskView } from "@/agent/views/renderAndSaveTaskView";

describe("renderAndSaveTaskView", () => {
  it("renders and saves one exact sequential mapping across sections", async () => {
    const first = makeItem("item-a", "A");
    const second = makeItem("item-b", "B");
    const third = makeItem("item-c", "C");

    const result = await renderAndSaveTaskView({
      userId: "user-id",
      timezone: "Europe/Moscow",
      viewType: "current",
      title: "Plan",
      sections: [
        { title: "One", items: [first] },
        { title: "Two", items: [second, third] },
      ],
    });

    expect(result.reply).toContain("1. Задача: A");
    expect(result.reply).toContain("2. Задача: B");
    expect(result.reply).toContain("3. Задача: C");
    expect(mocks.rememberTaskView).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({ id: "item-a", metadata: expect.objectContaining({ displayIndex: 1 }) }),
          expect.objectContaining({ id: "item-b", metadata: expect.objectContaining({ displayIndex: 2 }) }),
          expect.objectContaining({ id: "item-c", metadata: expect.objectContaining({ displayIndex: 3 }) }),
        ],
      }),
    );
  });
});

function makeItem(id: string, title: string): PlannerItem {
  const now = new Date("2026-06-07T09:00:00.000Z");
  return {
    id,
    userId: "user-id",
    pendingActionId: null,
    kind: "task",
    status: "active",
    title,
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAt: null,
    endAt: null,
    dueAt: null,
    completedAt: null,
    priority: 3,
    source: "telegram",
    metadata: { displayIndex: 99 },
    createdAt: now,
    updatedAt: now,
  };
}
