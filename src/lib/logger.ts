type LogDetails = Record<string, unknown>;

const secretPatterns = [/token/i, /secret/i, /key/i, /authorization/i, /refresh/i, /access/i];

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      secretPatterns.some((pattern) => pattern.test(key)) ? "[redacted]" : sanitize(item),
    ]),
  );
}

function log(level: "info" | "warn" | "error", message: string, details?: LogDetails) {
  const payload = details ? ` ${JSON.stringify(sanitize(details))}` : "";
  console[level](`[${level}] ${message}${payload}`);
}

export const logger = {
  info: (message: string, details?: LogDetails) => log("info", message, details),
  warn: (message: string, details?: LogDetails) => log("warn", message, details),
  error: (message: string, details?: LogDetails) => log("error", message, details),
};
