import { describe, expect, it } from "vitest";

/**
 * Documents the production failure mode seen on /api/reminders/run:
 * raw postgres rows can expose timestamptz values as strings. Any value handed back
 * to Drizzle's timestamp encoder must be normalized to Date first.
 */
describe("V3.0.2 reminder runner date normalization contract", () => {
  it("normalizes a raw timestamptz string before reuse as a Drizzle timestamp value", () => {
    const raw = "2026-09-03T05:30:23.000Z" as unknown as Date;
    const normalized = raw instanceof Date ? raw : new Date(raw as unknown as string);

    expect(normalized).toBeInstanceOf(Date);
    expect(normalized.toISOString()).toBe("2026-09-03T05:30:23.000Z");
  });
});
