const FAILURE_ACTION_PATTERN = /(failed|blocked|error)/i;

export function hardenAgentTraceDetails(details: Record<string, unknown>) {
  const normalized = { ...details };
  const finalAction = stringValue(normalized.finalAction);
  const errorCode = stringValue(normalized.errorCode);
  const failed =
    errorCode === "user_error" ||
    Boolean(errorCode && errorCode !== "none") ||
    FAILURE_ACTION_PATTERN.test(finalAction ?? "");

  if (finalAction?.includes("committed")) {
    delete normalized.cancelledAt;
    delete normalized.cancelledReason;
  } else if (finalAction?.includes("cancelled")) {
    delete normalized.committedAt;
  }

  if (!failed) return normalized;

  normalized.toolFailureReason =
    stringValue(normalized.toolFailureReason) ??
    stringValue(normalized.safeErrorMessage) ??
    errorCode ??
    "agent_execution_failed";
  normalized.toolFailureField =
    stringValue(normalized.toolFailureField) ??
    (errorCode === "missing_required_field" ? "required_field" : "not_applicable");
  normalized.suggestedNextPrompt =
    stringValue(normalized.suggestedNextPrompt) ??
    "Повтори запрос одним сообщением или уточни недостающие дату и время.";
  return normalized;
}

function stringValue(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "none" ? trimmed : null;
}
