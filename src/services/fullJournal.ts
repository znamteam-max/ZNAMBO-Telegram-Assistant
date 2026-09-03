import { and, desc, eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { listHistoricalTranscriptsByMessageIds } from "@/db/queries/messages";
import { agentActions, auditLog } from "@/db/schema";
import { hardenAgentTraceDetails } from "@/domain/agentTraceHygiene";
import { sanitizeForActionLog } from "@/services/actionLog";
import { listConversationMessagesForExport } from "@/services/conversation";

const MAX_ROWS_PER_SOURCE = 5000;

type JournalEvent = {
  createdAt: Date;
  source: "conversation" | "audit" | "agent_action";
  kind: string;
  body: string;
};

export async function buildFullJournal(params: {
  userId: string;
  hours?: number | null;
  all?: boolean;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const hours = params.all ? null : Math.max(1, Math.min(params.hours ?? 24, 24 * 365));
  const since = hours === null ? null : new Date(now.getTime() - hours * 60 * 60 * 1000);

  const [conversationRows, auditRows, actionRows] = await Promise.all([
    listConversationMessagesForExport({
      userId: params.userId,
      since,
      limit: MAX_ROWS_PER_SOURCE,
    }),
    listAuditRows({ userId: params.userId, since }),
    listAgentActionRows({ userId: params.userId, since }),
  ]);
  const historicalTranscriptRows = await listHistoricalTranscriptsByMessageIds({
    userId: params.userId,
    messageIds: conversationRows
      .filter((row) => row.role === "user" && !row.transcript && isMediaMessageType(row.messageType))
      .map((row) => row.telegramMessageId)
      .filter((value): value is string => Boolean(value)),
  });
  const historicalTranscripts = new Map(
    historicalTranscriptRows
      .filter((row) => typeof row.transcript === "string" && row.transcript.trim())
      .map((row) => [row.id, row.transcript!] as const),
  );

  const events: JournalEvent[] = [
    ...conversationRows.map((row) => conversationToEvent(row, historicalTranscripts)),
    ...auditRows.map(auditToEvent),
    ...actionRows.map(agentActionToEvent),
  ].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

  const header = [
    "# JARVIS FULL JOURNAL",
    "",
    `Generated: ${now.toISOString()}`,
    `Window: ${params.all ? "all retained history" : `last ${hours}h`}`,
    `Events: ${events.length}`,
    "",
    "> This is an observable audit journal: user inputs, voice transcripts, exact bot-visible outputs and Telegram lifecycle events, plus persisted routing/tool/state mutations. It does not contain or reconstruct hidden model chain-of-thought.",
    "> Secret-like credentials are redacted in the export.",
    "",
  ];

  const body = events.flatMap((event) => [
    `## ${event.createdAt.toISOString()} · ${event.kind}`,
    "",
    event.body || "_(no visible text)_",
    "",
  ]);

  return {
    text: [...header, ...body].join("\n"),
    eventCount: events.length,
    truncated:
      conversationRows.length >= MAX_ROWS_PER_SOURCE ||
      auditRows.length >= MAX_ROWS_PER_SOURCE ||
      actionRows.length >= MAX_ROWS_PER_SOURCE,
  };
}

export function parseFullJournalArgs(raw: string | undefined | null) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value === "24h" || value === "24ч") return { hours: 24, all: false };
  if (value === "all" || value === "все" || value === "всё") return { hours: null, all: true };
  const hourMatch = value.match(/^(\d{1,4})\s*(?:h|ч)$/);
  if (hourMatch) return { hours: Math.max(1, Math.min(Number(hourMatch[1]), 24 * 365)), all: false };
  const dayMatch = value.match(/^(\d{1,3})\s*(?:d|д)$/);
  if (dayMatch) return { hours: Math.max(24, Math.min(Number(dayMatch[1]) * 24, 24 * 365)), all: false };
  return { hours: 24, all: false };
}

async function listAuditRows(params: { userId: string; since: Date | null }) {
  const conditions = [eq(auditLog.userId, params.userId)];
  if (params.since) {
    conditions.push(sql`${auditLog.createdAt} >= ${params.since.toISOString()}::timestamptz`);
  }
  return getDb()
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt))
    .limit(MAX_ROWS_PER_SOURCE);
}

async function listAgentActionRows(params: { userId: string; since: Date | null }) {
  const conditions = [eq(agentActions.userId, params.userId)];
  if (params.since) {
    conditions.push(sql`${agentActions.createdAt} >= ${params.since.toISOString()}::timestamptz`);
  }
  return getDb()
    .select()
    .from(agentActions)
    .where(and(...conditions))
    .orderBy(desc(agentActions.createdAt))
    .limit(MAX_ROWS_PER_SOURCE);
}

function conversationToEvent(
  row: Awaited<ReturnType<typeof listConversationMessagesForExport>>[number],
  historicalTranscripts: Map<string, string>,
): JournalEvent {
  const metadata = row.metadata ?? {};
  const isUser = row.role === "user";
  const fallbackTranscript = row.telegramMessageId
    ? historicalTranscripts.get(row.telegramMessageId) ?? null
    : null;
  const transcript = row.transcript ?? fallbackTranscript;
  const visible = isUser ? transcript ?? row.text : row.text;
  const kind = isUser
    ? `USER/${row.messageType}${transcript ? "/transcript" : ""}`
    : `BOT/${row.messageType}`;
  const lifecycle = typeof metadata.lifecycle === "string" ? metadata.lifecycle : null;
  const outboundId = metadata.telegramOutboundMessageId ?? metadata.telegramMessageId ?? null;
  const metaLine = isUser
    ? fallbackTranscript && !row.transcript
      ? "transcript_source=historical_telegram_message"
      : null
    : [
        lifecycle ? `lifecycle=${lifecycle}` : null,
        outboundId ? `telegram_message_id=${String(outboundId)}` : null,
        metadata.telegramMethod ? `method=${String(metadata.telegramMethod)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  return {
    createdAt: row.createdAt,
    source: "conversation",
    kind,
    body: [visible ? redactSecretLikeText(visible) : null, metaLine || null].filter(Boolean).join("\n\n"),
  };
}

function auditToEvent(row: typeof auditLog.$inferSelect): JournalEvent {
  const details =
    row.action === "assistant.agent_decision_trace" ||
    row.action === "assistant.jarvis_trace" ||
    row.action === "assistant.decision_trace"
      ? hardenAgentTraceDetails(row.details)
      : row.details;
  return {
    createdAt: row.createdAt,
    source: "audit",
    kind: `INTERNAL/AUDIT/${row.action}`,
    body: safeJson({
      entityType: row.entityType,
      entityId: row.entityId,
      details: sanitizeForActionLog(details),
    }),
  };
}

function agentActionToEvent(row: typeof agentActions.$inferSelect): JournalEvent {
  return {
    createdAt: row.createdAt,
    source: "agent_action",
    kind: `INTERNAL/ACTION/${row.actionType}/${row.status}`,
    body: safeJson({
      sourceMessageId: row.sourceMessageId,
      input: sanitizeForActionLog(row.input),
      output: sanitizeForActionLog(row.output),
      undoPayloadPresent: Boolean(Object.keys(row.undoPayload ?? {}).length),
    }),
  };
}

function safeJson(value: unknown) {
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
