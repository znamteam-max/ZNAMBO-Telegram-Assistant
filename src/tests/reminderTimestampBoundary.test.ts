import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle as postgresDrizzle } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/pglite";
import { createReminderTestDb } from "./helpers/reminderTestDb";
import { reminderTimestamp, ReminderTimestampError } from "@/db/reminderTimestampBoundary";
import { reminders, reminderPolicies } from "@/db/schema";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), update: vi.fn(), writeAudit: vi.fn() }));
vi.mock("@/db/client", () => ({ getDb: () => ({ execute: mocks.execute, update: mocks.update }) }));
vi.mock("@/db/queries/audit", () => ({ writeAudit: mocks.writeAudit }));
import { claimDueReminders, markReminderFailed } from "@/db/queries/reminders";
import { acquireRuntimeLease } from "@/db/queries/runtimeLocks";

describe("external reminder timestamp boundary", () => {
  it("reproduces the installed postgres-js/Drizzle transparent timestamptz parser without connecting", async () => {
    const client = postgres("postgres://unused:unused@127.0.0.1:1/unused", { max: 1 });
    postgresDrizzle(client); // lazy client: no SQL/network is executed
    const wire = "2026-09-03 05:00:00.123456+00";
    const parser = (client.options as unknown as { parsers: Record<string, (value: string) => unknown> }).parsers["1184"];
    expect(parser(wire)).toBe(wire);
    expect(() => reminders.scheduledAt.mapToDriverValue(wire as unknown as Date)).toThrow(TypeError);
    expect(reminders.scheduledAt.mapToDriverValue(reminderTimestamp(wire, "scheduledAt"))).toBe("2026-09-03T05:00:00.123Z");
    // Typed ORM selects already decode policy/snooze fields, unlike execute().
    expect(reminderPolicies.nextFireAt.mapFromDriverValue(wire)).toBeInstanceOf(Date);
    expect(reminderPolicies.snoozedUntil.mapFromDriverValue(wire)).toBeInstanceOf(Date);
    await client.end();
  });
  it.each([new Date("2026-09-03T05:00:00Z"), "2026-09-03T05:00:00Z", "2026-09-03 08:00:00+03"])(
    "normalizes supported Date/serialized instant %s", (value) => {
      expect(reminderTimestamp(value, "scheduledAt").toISOString()).toBe("2026-09-03T05:00:00.000Z");
    },
  );
  it.each([null, undefined, {}, 0, "2026-02-30T05:00:00Z", "2026-09-03T05:00:00", "secret-value", "-infinity", new Date(NaN)])(
    "rejects invalid input without coercion or secret disclosure (%#)", (value) => {
      expect(() => reminderTimestamp(value, "scheduledAt")).toThrow(ReminderTimestampError);
      expect(() => reminderTimestamp(value, "scheduledAt")).toThrow("invalid_reminder_timestamp:scheduledAt");
    },
  );
});

describe("raw SQL claim -> Date domain -> typed SQL update", () => {
  let db: Awaited<ReturnType<typeof createReminderTestDb>>;
  const owner = "00000000-0000-4000-8000-000000000001";
  const now = new Date("2026-09-03T06:00:00Z");
  beforeAll(async () => {
    db = await createReminderTestDb({ rawTimestamps: true });
    const orm = drizzle(db.pg);
    mocks.execute.mockImplementation(db.execute);
    mocks.update.mockImplementation((table) => orm.update(table));
    await db.pg.exec(`create table assistant.runtime_locks (
      key text primary key, owner_token text, locked_until timestamptz,
      acquired_at timestamptz, updated_at timestamptz
    )`);
  }, 30_000);
  beforeEach(async () => {
    await db.pg.exec("truncate assistant.reminders, assistant.runtime_locks");
    mocks.writeAudit.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => { await db?.pg.close(); });
  async function insert(at: string) {
    return (await db.pg.query<{ id: string }>(`
      insert into assistant.reminders(user_id, scheduled_at, attempt_count, idempotency_key)
      values ($1, $2, 2, 'test-occurrence') returning id`, [owner, at])).rows[0].id;
  }
  it("normalizes every returned timestamp and survives the terminal runner-failure update", async () => {
    await insert("2026-09-03T05:00:00Z");
    const [row] = await claimDueReminders({ now, limit: 100 });
    expect(row.scheduledAt.toISOString()).toBe("2026-09-03T05:00:00.000Z");
    expect(row.claimedAt).toBeInstanceOf(Date);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(row.sentAt).toBeNull();
    expect(row.ackedAt).toBeNull();
    expect(row.idempotencyKey).toBe("test-occurrence");
    // Before the fix the third-attempt failure passed the raw string back into
    // PgTimestamp.mapToDriverValue -> .toISOString TypeError outside the runner catch.
    await expect(markReminderFailed({ reminder: row, error: "simulated_delivery_failure" })).resolves.toBeUndefined();
    expect((await db.pg.query<{ status: string }>("select status from assistant.reminders" )).rows[0].status).toBe("failed");
  });
  it("rejects a non-finite DB timestamp with a safe audit while claiming valid siblings", async () => {
    const invalid = await insert("-infinity");
    const valid = await insert("2026-09-03T05:00:00Z");
    const claimed = await claimDueReminders({ now, limit: 100 });
    expect(claimed.map((row) => row.id)).toEqual([valid]);
    expect(mocks.writeAudit).toHaveBeenCalledWith({
      userId: owner, entityId: invalid, entityType: "reminder",
      action: "assistant.reminder_timestamp_invalid",
      details: { boundary: "runner_claim", field: "scheduledAt", code: "invalid_reminder_timestamp" },
    });
    const row = (await db.pg.query<{ status: string; last_error: string }>(
      "select status, last_error from assistant.reminders where id=$1", [invalid],
    )).rows[0];
    expect(row).toEqual({ status: "failed", last_error: "invalid_reminder_timestamp:scheduledAt" });
  });
  it("normalizes the raw scheduler lease timestamp as well", async () => {
    const lease = await acquireRuntimeLease({ key: "reminder_runner", ownerToken: "test-owner", now, leaseSeconds: 55 });
    expect(lease?.lockedUntil.toISOString()).toBe("2026-09-03T06:00:55.000Z");
  });
});
