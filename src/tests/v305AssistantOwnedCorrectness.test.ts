import { describe, expect, it } from "vitest";

import {
  formatReminderCadence,
  normalizeUntilDoneReminder,
  parseExplicitReminderIntervalMinutes,
} from "@/domain/untilDoneReminderText";
import {
  parseReminderCadence,
  parseReminderPolicyDraftInput,
} from "@/bot/reminderPolicyEditFlow";
import { sanitizePlannerTitle } from "@/domain/titleSanitizer";
import { sanitizeForActionLog } from "@/services/actionLog";
import { isReadOnlyDiagnosticCommand, slashCommandName } from "@/bot/createBot";
import { parseTraceExportArgs } from "@/services/traceExport";

describe("V3.0.5 assistant-owned correctness fixes", () => {
  it("parses explicit N-hour reminder cadences", () => {
    expect(parseExplicitReminderIntervalMinutes("каждый час")).toBe(60);
    expect(parseExplicitReminderIntervalMinutes("каждые 2 часа")).toBe(120);
    expect(parseExplicitReminderIntervalMinutes("каждые 4 часа")).toBe(240);
    expect(parseExplicitReminderIntervalMinutes("каждые 12 часов")).toBe(720);
    expect(parseExplicitReminderIntervalMinutes("раз в 4 часа")).toBe(240);
    expect(formatReminderCadence(240)).toBe("каждые 4 часа");
  });

  it("preserves both cadence and reminder window in reminder policy edit parsing", () => {
    const input = parseReminderPolicyDraftInput("каждые 2 часа до 18:00");
    expect(input.intervalMinutes).toBe(120);
    expect(input.windowEnd).toBe("18:00");
  });

  it("keeps explicit four-hour cadence in until-done normalization", () => {
    const normalized = normalizeUntilDoneReminder({
      text: "Каждые 4 часа, пока не отмечу",
      timezone: "Europe/Moscow",
      now: new Date("2026-09-03T09:00:00.000Z"),
    });
    expect(normalized?.intervalMinutes).toBe(240);
    expect(normalized?.cadenceExplicit).toBe(true);
  });

  it("uses N-hour cadence in a complete interval-window edit", () => {
    const parsed = parseReminderCadence({
      text: "каждые 2 часа с 08:00 до 18:00",
      timezone: "Europe/Moscow",
      now: new Date("2026-09-03T01:00:00.000Z"),
    });
    expect(parsed?.intervalMinutes).toBe(120);
    expect(parsed?.windowStart).toBe("08:00");
    expect(parsed?.windowEnd).toBe("18:00");
  });

  it("cleans the historical NHL to KHL spoken correction without losing reminder semantics", () => {
    expect(
      sanitizePlannerTitle(
        "У меня созвон по НХЛ, нет, не по НХЛ, по КХЛ, созвон по КХЛ. Предупреди за полчаса до созвона и за 5 минут до созвона",
      ),
    ).toBe("Созвон по КХЛ");
  });

  it("does not collapse an ordinary negation that is not an explicit spoken correction", () => {
    expect(sanitizePlannerTitle("Встреча не по работе, а по личному вопросу")).toBe(
      "Встреча не по работе, а по личному вопросу",
    );
  });

  it("keeps numeric token usage visible while redacting actual token secrets", () => {
    const safe = sanitizeForActionLog({
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
      accessToken: "secret-value",
      apiKey: "secret-value",
    });
    expect(safe.inputTokens).toBe(123);
    expect(safe.outputTokens).toBe(45);
    expect(safe.totalTokens).toBe(168);
    expect(safe.accessToken).toBe("[redacted]");
    expect(safe.apiKey).toBe("[redacted]");
  });

  it("recognizes diagnostic slash commands including bot username suffixes as read-only", () => {
    expect(slashCommandName("/fulllog_export@JarvisBot 24h")).toBe("fulllog_export");
    expect(isReadOnlyDiagnosticCommand("/fulllog_export 24h")).toBe(true);
    expect(isReadOnlyDiagnosticCommand("/trace_export 7d")).toBe(true);
    expect(isReadOnlyDiagnosticCommand("/apiusage")).toBe(true);
    expect(isReadOnlyDiagnosticCommand("/plan")).toBe(false);
  });

  it("parses compact trace export windows", () => {
    expect(parseTraceExportArgs("")).toEqual({ hours: 24 });
    expect(parseTraceExportArgs("48h")).toEqual({ hours: 48 });
    expect(parseTraceExportArgs("7d")).toEqual({ hours: 168 });
  });
});
