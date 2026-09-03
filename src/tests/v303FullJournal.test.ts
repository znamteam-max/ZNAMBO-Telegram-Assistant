import { describe, expect, it } from "vitest";

import { parseFullJournalArgs } from "@/services/fullJournal";

describe("V3.0.3 full journal export", () => {
  it("defaults to a 24 hour export", () => {
    expect(parseFullJournalArgs("")).toEqual({ hours: 24, all: false });
  });

  it("supports explicit hour, day and all-history windows", () => {
    expect(parseFullJournalArgs("48h")).toEqual({ hours: 48, all: false });
    expect(parseFullJournalArgs("7d")).toEqual({ hours: 168, all: false });
    expect(parseFullJournalArgs("all")).toEqual({ hours: null, all: true });
  });

  it("caps an excessively large requested window at one year", () => {
    expect(parseFullJournalArgs("999d")).toEqual({ hours: 24 * 365, all: false });
  });
});
