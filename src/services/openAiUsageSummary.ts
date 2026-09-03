import { DateTime } from "luxon";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { auditLog } from "@/db/schema";

const USAGE_ACTIONS = ["assistant.agent_decision_trace", "assistant.openai_usage"];

type TokenTotals = {
  calls: number;
  succeeded: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  models: Set<string>;
  unmeteredCalls: number;
};

export async function buildOpenAiUsageSummary(params: {
  userId: string;
  timezone: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const localNow = DateTime.fromJSDate(now, { zone: "utc" }).setZone(params.timezone);
  const monthStart = localNow.startOf("month").toUTC().toJSDate();
  const todayStart = localNow.startOf("day").toUTC().toJSDate();
  const rows = await getDb()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, params.userId),
        inArray(auditLog.action, USAGE_ACTIONS),
        sql`${auditLog.createdAt} >= ${monthStart.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(auditLog.createdAt))
    .limit(10_000);

  const month = emptyTotals();
  const today = emptyTotals();
  for (const row of rows) {
    const usage = usageFromAudit(row.action, row.details);
    if (!usage) continue;
    addUsage(month, usage);
    if (row.createdAt >= todayStart) addUsage(today, usage);
  }

  return {
    today: freezeTotals(today),
    month: freezeTotals(month),
    text: [
      "OpenAI API — локальный учёт JARVIS",
      "",
      formatTotals("Сегодня", today),
      formatTotals("С начала месяца", month),
      "",
      "Это расход токенов, который сам JARVIS смог зафиксировать в ответах OpenAI. Это не остаток баланса.",
      "У API нет универсального «остатка токенов»: денежный баланс зависит от модели и типа токенов. Остаток кредитов/лимит проверяется в OpenAI Platform → Billing, а общий расход — в Usage.",
      month.unmeteredCalls
        ? `В этом месяце есть ${month.unmeteredCalls} OpenAI-выз. без token usage в ответе (например, отдельные варианты транскрипции); они не входят в total_tokens выше.`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function usageFromAudit(action: string, details: Record<string, unknown>) {
  if (action === "assistant.agent_decision_trace") {
    if (details.aiCalled !== true) return null;
    return {
      succeeded: details.aiSucceeded === true,
      inputTokens: numberOrZero(details.inputTokens),
      outputTokens: numberOrZero(details.outputTokens),
      totalTokens: numberOrZero(details.totalTokens),
      model: stringOrNull(details.aiModel),
      metered: hasTokenValue(details),
    };
  }
  if (action === "assistant.openai_usage") {
    return {
      succeeded: details.succeeded !== false,
      inputTokens: numberOrZero(details.inputTokens ?? details.promptTokens),
      outputTokens: numberOrZero(details.outputTokens ?? details.completionTokens),
      totalTokens: numberOrZero(details.totalTokens),
      model: stringOrNull(details.model),
      metered: hasTokenValue(details),
    };
  }
  return null;
}

function hasTokenValue(details: Record<string, unknown>) {
  return [
    details.inputTokens,
    details.promptTokens,
    details.outputTokens,
    details.completionTokens,
    details.totalTokens,
  ].some((value) => typeof value === "number" && Number.isFinite(value));
}

function emptyTotals(): TokenTotals {
  return {
    calls: 0,
    succeeded: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    models: new Set<string>(),
    unmeteredCalls: 0,
  };
}

function addUsage(
  target: TokenTotals,
  usage: {
    succeeded: boolean;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model: string | null;
    metered: boolean;
  },
) {
  target.calls += 1;
  if (usage.succeeded) target.succeeded += 1;
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  if (usage.model) target.models.add(usage.model);
  if (!usage.metered) target.unmeteredCalls += 1;
}

function freezeTotals(value: TokenTotals) {
  return {
    calls: value.calls,
    succeeded: value.succeeded,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    models: [...value.models],
    unmeteredCalls: value.unmeteredCalls,
  };
}

function formatTotals(label: string, value: TokenTotals) {
  const models = [...value.models].join(", ") || "—";
  return [
    `${label}: ${formatNumber(value.totalTokens)} tokens · ${value.calls} API calls`,
    `input ${formatNumber(value.inputTokens)} · output ${formatNumber(value.outputTokens)} · success ${value.succeeded}/${value.calls}`,
    `models: ${models}`,
  ].join("\n");
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
