import { createHmac, timingSafeEqual } from "node:crypto";

export function constantTimeEquals(
  actual: string | null | undefined,
  expected: string | null | undefined,
) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function signState(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSignedState(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signState(body, secret)}`;
}

export function verifySignedState<T>(state: string, secret: string): T | null {
  const [body, signature] = state.split(".");
  if (!body || !signature) return null;
  if (!constantTimeEquals(signature, signState(body, secret))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
