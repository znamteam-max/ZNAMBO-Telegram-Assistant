import { describe, expect, it } from "vitest";

import { isAllowedTelegramUserId } from "@/bot/authorization";

describe("Telegram allowlist", () => {
  it("allows only configured owner ids", () => {
    expect(isAllowedTelegramUserId(42)).toBe(true);
    expect(isAllowedTelegramUserId("42")).toBe(true);
    expect(isAllowedTelegramUserId(7)).toBe(false);
  });
});
