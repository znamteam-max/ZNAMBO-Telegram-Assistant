import { describe, expect, it } from "vitest";

import { isSelfContainedPlanEditReplacement } from "@/bot/planEditFlow";

describe("V3.0.4 pending plan edit target lock", () => {
  it("blocks the exact ambiguous follow-up that previously mutated another item", () => {
    expect(isSelfContainedPlanEditReplacement("18.00")).toBe(false);
  });

  it("blocks other context-only corrections from entering global item updates", () => {
    expect(isSelfContainedPlanEditReplacement("завтра")).toBe(false);
    expect(isSelfContainedPlanEditReplacement("нет, в 19.00")).toBe(false);
  });

  it("allows a self-contained meeting replacement to re-enter creation routing", () => {
    expect(isSelfContainedPlanEditReplacement("Созвон по Взял Мяч сегодня в 18.00")).toBe(true);
  });

  it("allows an explicit task creation replacement", () => {
    expect(
      isSelfContainedPlanEditReplacement("Добавь задачу проверить отчёт завтра до 12:00"),
    ).toBe(true);
  });
});
