import { describe, expect, it } from "vitest";

import { formatRuItemsRequireDecision, formatRuPlural } from "@/lib/ruPlural";

describe("Russian pluralization", () => {
  it.each([
    [1, "1 пункт"],
    [2, "2 пункта"],
    [4, "4 пункта"],
    [5, "5 пунктов"],
    [11, "11 пунктов"],
    [21, "21 пункт"],
    [22, "22 пункта"],
  ])("formats %i correctly", (count, expected) => {
    expect(formatRuPlural(count, ["пункт", "пункта", "пунктов"])).toBe(expected);
  });

  expect(formatRuItemsRequireDecision(4)).toBe("4 пункта требуют решения");
  expect(formatRuItemsRequireDecision(21)).toBe("21 пункт требует решения");
});
