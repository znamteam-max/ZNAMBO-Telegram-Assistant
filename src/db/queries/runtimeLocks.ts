import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../client";
import { runtimeLocks } from "../schema";

export async function acquireRuntimeLease(params: {
  key: string;
  ownerToken: string;
  now: Date;
  leaseSeconds: number;
}) {
  const lockedUntil = new Date(params.now.getTime() + params.leaseSeconds * 1000);
  const rows = await getDb().execute(sql`
    insert into "assistant"."runtime_locks"
      ("key", "owner_token", "locked_until", "acquired_at", "updated_at")
    values (
      ${params.key},
      ${params.ownerToken},
      ${lockedUntil.toISOString()}::timestamptz,
      ${params.now.toISOString()}::timestamptz,
      ${params.now.toISOString()}::timestamptz
    )
    on conflict ("key") do update
    set "owner_token" = excluded."owner_token",
        "locked_until" = excluded."locked_until",
        "acquired_at" = excluded."acquired_at",
        "updated_at" = excluded."updated_at"
    where "assistant"."runtime_locks"."locked_until" < ${params.now.toISOString()}::timestamptz
    returning "key", "owner_token" as "ownerToken", "locked_until" as "lockedUntil"
  `);
  return (rows[0] as { key: string; ownerToken: string; lockedUntil: Date } | undefined) ?? null;
}

export async function releaseRuntimeLease(params: { key: string; ownerToken: string }) {
  const [released] = await getDb()
    .delete(runtimeLocks)
    .where(and(eq(runtimeLocks.key, params.key), eq(runtimeLocks.ownerToken, params.ownerToken)))
    .returning({ key: runtimeLocks.key });
  return released ?? null;
}

export async function getRuntimeLease(key: string) {
  const [row] = await getDb().select().from(runtimeLocks).where(eq(runtimeLocks.key, key)).limit(1);
  return row ?? null;
}
