import { createHash } from "node:crypto";

export function createIdempotencyKey(
  parts: Array<string | number | bigint | null | undefined>,
): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join(":"))
    .digest("hex");
}
