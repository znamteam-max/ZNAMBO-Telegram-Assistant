import { describe, expect, it } from "vitest";

import { formatLocalDateTime, localIsoToUtcDate } from "@/domain/dateTime";

describe("date/time conversion", () => {
  it("stores local time as UTC and displays it back in local timezone", () => {
    const utc = localIsoToUtcDate("2026-05-28T12:00:00", "Europe/Helsinki");
    expect(utc.toISOString()).toBe("2026-05-28T09:00:00.000Z");
    expect(formatLocalDateTime(utc, "Europe/Helsinki")).toContain("12");
  });
});
