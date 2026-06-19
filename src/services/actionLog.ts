import { listRecentAgentActions } from "@/db/queries/agentActions";
import { listRecentAuditLogs } from "@/db/queries/audit";
import { hardenAgentTraceDetails } from "@/domain/agentTraceHygiene";

type ActionLogEntry = {
  source: "audit" | "agent_action";
  id: string;
  createdAt: Date;
  action: string;
  status?: string | null;
  entityId?: string | null;
  details: Record<string, unknown>;
};

export async function buildActionLog(params: {
  userId: string;
  hours?: number;
  limit?: number;
  exportMode?: boolean;
}) {
  const hours = params.hours ?? 24;
  const limit = Math.max(1, Math.min(params.limit ?? 30, params.exportMode ? 200 : 50));
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [auditRows, agentRows] = await Promise.all([
    listRecentAuditLogs({ userId: params.userId, since, limit: Math.min(limit * 4, 200) }),
    listRecentAgentActions({ userId: params.userId, since, limit }),
  ]);
  const entries: ActionLogEntry[] = [
    ...auditRows.map((row) => ({
      source: "audit" as const,
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      entityId: row.entityId,
      details: sanitizeForActionLog(
        row.action === "assistant.agent_decision_trace" ||
          row.action === "assistant.jarvis_trace" ||
          row.action === "assistant.decision_trace"
          ? hardenAgentTraceDetails(row.details)
          : row.details,
      ),
    })),
    ...agentRows.map((row) => {
      const output = normalizeAgentActionOutputForLog(row.status, row.output);
      return {
        source: "agent_action" as const,
        id: row.id,
        createdAt: row.createdAt,
        action: row.actionType,
        status: row.status,
        details: sanitizeForActionLog({
          input: row.input,
          output,
          createdItemIds: output.createdItemIds,
          updatedItemIds: output.updatedItemIds,
          createdPolicyIds: output.createdPolicyIds,
          createdReminderIds: output.createdReminderIds,
          undoPayloadPresent: Boolean(Object.keys(row.undoPayload ?? {}).length),
        }),
      };
    }),
  ];
  const collapsed = collapseMonthlyAuditSpam(entries)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, limit);

  const lines = [
    `Action log: last ${hours}h, ${collapsed.length} entries`,
    "",
    ...collapsed.flatMap((entry, index) => [
      `${index + 1}. ${formatDate(entry.createdAt)} · ${entry.source} · ${entry.action}${entry.status ? ` · ${entry.status}` : ""}`,
      `   id: ${entry.id}`,
      `   ${summarizeDetails(entry.details, params.exportMode === true)}`,
    ]),
  ];
  return {
    text: lines.join("\n").slice(0, params.exportMode ? 80_000 : 3_800),
    entries: collapsed,
  };
}

export function collapseMonthlyAuditSpam(entries: ActionLogEntry[]) {
  const seen = new Map<string, ActionLogEntry>();
  const output: ActionLogEntry[] = [];
  for (const entry of [...entries].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
  )) {
    if (
      entry.action !== "assistant.monthly_day_range_occurrence_checked" &&
      !isLowValueRepeatedReminderAudit(entry)
    ) {
      output.push(entry);
      continue;
    }
    const auditKey = isLowValueRepeatedReminderAudit(entry)
      ? String(
          entry.details.targetPolicyId ??
            entry.details.targetReminderId ??
            entry.details.targetItemId ??
            entry.entityId ??
            "unknown",
        )
      : typeof entry.details.auditKey === "string"
        ? entry.details.auditKey
        : typeof entry.details.scheduledFor === "string"
          ? String(entry.details.scheduledFor).slice(0, 10)
          : "unknown";
    const key = `${entry.action}:${entry.entityId ?? "none"}:${auditKey}`;
    const existing = seen.get(key);
    if (existing) {
      existing.details = {
        ...existing.details,
        collapsedDuplicates: Number(existing.details.collapsedDuplicates ?? 0) + 1,
      };
      continue;
    }
    seen.set(key, entry);
    output.push(entry);
  }
  return output;
}

function isLowValueRepeatedReminderAudit(entry: ActionLogEntry) {
  if (
    [
      "assistant.renag_card_sent_loud",
      "assistant.renag_previous_card_deleted",
      "assistant.renag_edit_noop_success",
      "assistant.renag_duplicate_visible_card_prevented",
    ].includes(entry.action)
  ) {
    return true;
  }
  return (
    entry.action === "assistant.telegram_send_mode" &&
    ["renag_alert", "dashboard_refresh"].includes(String(entry.details.messageKind ?? ""))
  );
}

export function normalizeAgentActionOutputForLog(
  status: string | null | undefined,
  output: Record<string, unknown>,
) {
  const normalized = { ...output };
  if (status === "completed") {
    delete normalized.cancelledAt;
    delete normalized.cancelledReason;
  } else if (status === "cancelled") {
    delete normalized.committedAt;
    delete normalized.completedAt;
  }
  return normalized;
}

export function parseActionLogArgs(raw: string | undefined | null) {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!value) return { hours: 24, limit: 30, exportMode: false };
  if (value === "export") return { hours: 24, limit: 200, exportMode: true };
  const hourMatch = value.match(/^(\d{1,3})\s*h$/);
  if (hourMatch) {
    return {
      hours: Math.max(1, Math.min(Number(hourMatch[1]), 168)),
      limit: 50,
      exportMode: false,
    };
  }
  const limit = Number(value);
  if (Number.isFinite(limit) && limit > 0) {
    return { hours: 24, limit: Math.min(Math.round(limit), 200), exportMode: false };
  }
  return { hours: 24, limit: 30, exportMode: false };
}

export function sanitizeForActionLog(value: unknown): Record<string, unknown> {
  return sanitizeValue(value) as Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return redactSecretLikeString(value);
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      isSensitiveKey(key) ? "[redacted]" : sanitizeValue(nested),
    ]),
  );
}

function isSensitiveKey(key: string) {
  return /(secret|token|password|authorization|api[_-]?key|database[_-]?url|connection[_-]?string|bearer)/i.test(
    key,
  );
}

function redactSecretLikeString(value: string) {
  if (/sk-[A-Za-z0-9_-]{12,}/.test(value)) return "[redacted]";
  if (/postgres(?:ql)?:\/\/\S+/i.test(value)) return "[redacted]";
  if (/Bearer\s+\S+/i.test(value)) return "[redacted]";
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function summarizeDetails(details: Record<string, unknown>, verbose: boolean) {
  const interesting = {
    finalAction: details.finalAction,
    aiCalled: details.aiCalled,
    aiSucceeded: details.aiSucceeded,
    createdItemIds: details.createdItemIds,
    updatedItemIds: details.updatedItemIds,
    createdPolicyIds: details.createdPolicyIds,
    validationWarnings: details.validationWarnings,
    errorCode: details.errorCode,
    input: verbose ? details.input : undefined,
    output: verbose ? details.output : undefined,
  };
  const filtered = Object.fromEntries(
    Object.entries(interesting).filter(([, value]) => value !== undefined),
  );
  const payload = Object.keys(filtered).length ? filtered : details;
  return JSON.stringify(payload).slice(0, verbose ? 5000 : 900);
}

function formatDate(date: Date) {
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "Z");
}
