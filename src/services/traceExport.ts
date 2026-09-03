import { and, asc, eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { listHistoricalTranscriptsByMessageIds } from "@/db/queries/messages";
import { agentActions, auditLog } from "@/db/schema";
import { sanitizeForActionLog } from "@/services/actionLog";
import { listConversationMessagesForExport } from "@/services/conversation";

const MAX_ROWS = 5000;

type ConversationRow = Awaited<ReturnType<typeof listConversationMessagesForExport>>[number];
type AuditRow = typeof auditLog.$inferSelect;

export function parseTraceExportArgs(raw: string | undefined | null) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value === "24h" || value === "24ч") return { hours: 24 };
  const hourMatch = value.match(/^(\d{1,4})\s*(?:h|ч)$/);
  if (hourMatch) return { hours: Math.max(1, Math.min(Number(hourMatch[1]), 24 * 365)) };
  const dayMatch = value.match(/^(\d{1,3})\s*(?:d|д)$/);
  if (dayMatch) return { hours: Math.max(24, Math.min(Number(dayMatch[1]) * 24, 24 * 365)) };
  return { hours: 24 };
}

export async function buildTraceExport(params: {
  userId: string;
  hours?: number;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const hours = Math.max(1, Math.min(params.hours ?? 24, 24 * 365));
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const [conversationRows, audits, actions] = await Promise.all([
    listConversationMessagesForExport({ userId: params.userId, since, limit: MAX_ROWS }),
    listAuditRows({ userId: params.userId, since }),
    listActionRows({ userId: params.userId, since }),
  ]);

  const missingTranscriptIds = conversationRows
    .filter((row) => row.role === "user" && !row.transcript && isMediaMessageType(row.messageType))
    .map((row) => row.telegramMessageId)
    .filter((value): value is string => Boolean(value));
  const fallbackRows = await listHistoricalTranscriptsByMessageIds({
    userId: params.userId,
    messageIds: missingTranscriptIds,
  });
  const fallbackTranscripts = new Map(
    fallbackRows
      .filter((row) => typeof row.transcript === "string" && row.transcript.trim())
      .map((row) => [row.id, row.transcript!] as const),
  );

  const userTurns = conversationRows
    .filter((row) => row.role === "user" && row.messageType !== "callback")
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  const lines = [
    "# JARVIS CAUSAL TRACE",
    "",
    `Generated: ${now.toISOString()}`,
    `Window: last ${hours}h`,
    `User turns: ${userTurns.length}`,
    "",
    "> Observable routing/action telemetry only. Hidden model chain-of-thought is not recorded or reconstructed.",
    "",
  ];

  for (const [index, turn] of userTurns.entries()) {
    const sourceMessageId = turn.telegramMessageId;
    const transcript = turn.transcript ?? (sourceMessageId ? fallbackTranscripts.get(sourceMessageId) : null);
    const visibleText = transcript ?? turn.text ?? "_(no visible text)_";
    const matchedActions = sourceMessageId
      ? actions.filter((action) => action.sourceMessageId === sourceMessageId)
      : [];
    const matchedAudits = sourceMessageId
      ? audits.filter((audit) => auditMatchesSource(audit, sourceMessageId))
      : [];
    const directBotRows = sourceMessageId
      ? conversationRows.filter(
          (row) => row.role === "assistant" && row.telegramMessageId === sourceMessageId,
        )
      : [];
    const outboundIds = new Set(
      directBotRows
        .map(getOutboundTelegramMessageId)
        .filter((value): value is string => Boolean(value)),
    );
    const lifecycleRows = conversationRows.filter((row) => {
      if (row.role !== "assistant" || !["telegram_edit", "telegram_delete"].includes(row.messageType)) {
        return false;
      }
      const outboundId = getOutboundTelegramMessageId(row);
      return Boolean(outboundId && outboundIds.has(outboundId));
    });
    const decisionTrace = [...matchedAudits]
      .reverse()
      .find((audit) =>
        ["assistant.agent_decision_trace", "assistant.jarvis_trace", "assistant.decision_trace"].includes(
          audit.action,
        ),
      );

    lines.push(
      `## ${index + 1}. ${turn.createdAt.toISOString()} · ${turn.messageType}`,
      "",
      "### USER",
      redactSecretLikeText(visibleText),
      "",
      `source_message_id: ${sourceMessageId ?? "—"}`,
      `telegram_message_id: ${String(turn.metadata?.telegramMessageId ?? "—")}`,
      "",
    );

    if (decisionTrace) {
      lines.push("### ROUTER / AI", fencedJson(summarizeDecisionTrace(decisionTrace.details)), "");
    }

    if (matchedActions.length) {
      lines.push(
        "### ACTIONS",
        ...matchedActions.flatMap((action) => [
          `- ${action.actionType} · ${action.status} · ${action.id}`,
          fencedJson(
            sanitizeForActionLog({
              input: action.input,
              output: action.output,
              sourceMessageId: action.sourceMessageId,
            }),
          ),
        ]),
        "",
      );
    }

    const additionalAudits = matchedAudits.filter((audit) => audit.id !== decisionTrace?.id);
    if (additionalAudits.length) {
      lines.push(
        "### AUDIT / STATE",
        ...additionalAudits.flatMap((audit) => [
          `- ${audit.action}${audit.entityId ? ` · ${audit.entityId}` : ""}`,
          fencedJson(sanitizeForActionLog(audit.details)),
        ]),
        "",
      );
    }

    const botRows = [...directBotRows, ...lifecycleRows].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
    if (botRows.length) {
      lines.push(
        "### BOT OUTPUT / LIFECYCLE",
        ...botRows.flatMap((row) => {
          const outboundId = getOutboundTelegramMessageId(row) ?? "—";
          const text = row.text ? redactSecretLikeText(row.text) : "_(no text)_";
          return [
            `- ${row.createdAt.toISOString()} · ${row.messageType} · telegram_message_id=${outboundId}`,
            text,
          ];
        }),
        "",
      );
    }
  }

  return {
    text: lines.join("\n"),
    turnCount: userTurns.length,
    truncated:
      conversationRows.length >= MAX_ROWS || audits.length >= MAX_ROWS || actions.length >= MAX_ROWS,
  };
}

async function listAuditRows(params: { userId: string; since: Date }) {
  return getDb()
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, params.userId),
        sql`${auditLog.createdAt} >= ${params.since.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(auditLog.createdAt))
    .limit(MAX_ROWS);
}

async function listActionRows(params: { userId: string; since: Date }) {
  return getDb()
    .select()
    .from(agentActions)
    .where(
      and(
        eq(agentActions.userId, params.userId),
        sql`${agentActions.createdAt} >= ${params.since.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(agentActions.createdAt))
    .limit(MAX_ROWS);
}

function auditMatchesSource(audit: AuditRow, sourceMessageId: string) {
  if (audit.entityId === sourceMessageId) return true;
  const details = audit.details ?? {};
  return [
    details.sourceMessageId,
    details.sourceTelegramMessageId,
    details.telegramMessageId,
    details.messageId,
  ].some((value) => typeof value === "string" && value === sourceMessageId);
}

function summarizeDecisionTrace(details: Record<string, unknown>) {
  return sanitizeForActionLog({
    preRouterIntent: details.preRouterIntent,
    sessionRouting: details.sessionRouting,
    aiRequired: details.aiRequired,
    aiCalled: details.aiCalled,
    aiSucceeded: details.aiSucceeded,
    aiModel: details.aiModel,
    inputTokens: details.inputTokens,
    outputTokens: details.outputTokens,
    totalTokens: details.totalTokens,
    toolCallsProposed: details.toolCallsProposed,
    toolCallsExecuted: details.toolCallsExecuted,
    finalAction: details.finalAction,
    fallbackUsed: details.fallbackUsed,
    fallbackReason: details.fallbackReason,
    validationWarnings: details.validationWarnings,
    errorCode: details.errorCode,
    safeErrorMessage: details.safeErrorMessage,
  });
}

function getOutboundTelegramMessageId(row: ConversationRow) {
  const metadata = row.metadata ?? {};
  const value = metadata.telegramOutboundMessageId ?? metadata.telegramMessageId;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function fencedJson(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function redactSecretLikeText(value: string) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-openai-key]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-database-url]");
}

function isMediaMessageType(messageType: string) {
  return ["voice", "audio", "video_note", "video"].includes(messageType);
}
