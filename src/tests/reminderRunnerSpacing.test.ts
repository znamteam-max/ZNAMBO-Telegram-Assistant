import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReminderTestDb } from "./helpers/reminderTestDb";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), writeAudit: vi.fn() }));
vi.mock("@/db/client", () => ({ getDb: () => ({ execute: mocks.execute }) }));
vi.mock("@/db/queries/audit", () => ({ writeAudit: mocks.writeAudit }));
import { claimDueReminders } from "@/db/queries/reminders";

describe("runner occurrence spacing contract (real in-memory SQL)", () => {
  let db: Awaited<ReturnType<typeof createReminderTestDb>>;
  const owner = "00000000-0000-4000-8000-000000000001";
  const desired = "2026-09-03T05:00:00.000Z";
  beforeAll(async () => {
    db = await createReminderTestDb();
    mocks.execute.mockImplementation(db.execute);
  }, 30_000);
  afterAll(async () => { await db?.pg.close(); });
  beforeEach(async () => {
    await db.pg.exec("truncate assistant.reminders, assistant.reminder_policies, assistant.planner_items");
    mocks.writeAudit.mockReset().mockResolvedValue(undefined);
  });
  async function insert(options: {
    scheduledAt?: string; purpose?: string; payload?: object; key?: string;
  } = {}) {
    const result = await db.pg.query<{ id: string }>(`
      insert into assistant.reminders(user_id, scheduled_at, purpose, payload, idempotency_key)
      values ($1, $2, $3, $4, $5) returning id`,
    [owner, options.scheduledAt ?? desired, options.purpose ?? "reminder", options.payload ?? {}, options.key ?? null]);
    return result.rows[0].id;
  }
  async function snapshot(id: string) {
    return (await db.pg.query<{ scheduled_at: Date; payload: Record<string, unknown> }>(
      "select scheduled_at, payload from assistant.reminders where id=$1", [id],
    )).rows[0];
  }

  it.each([30, 60, 120, 240])("keeps +%i minutes exact after runner claim, including minute-aligned writes", async (minutes) => {
    const at = new Date(new Date("2026-09-03T03:00:00Z").getTime() + minutes * 60_000);
    await insert({ scheduledAt: at.toISOString() });
    const id = await insert({ scheduledAt: at.toISOString(), purpose: "snooze" });
    const claimed = await claimDueReminders({ now: new Date(at.getTime() + 37_000), limit: 100 });
    expect(claimed.some((row) => row.id === id)).toBe(true);
    expect((await snapshot(id)).scheduled_at).toEqual(at);
    expect((await snapshot(id)).payload).toMatchObject({ userExplicitSnooze: true, spacingAlreadyApplied: false });
    expect(mocks.writeAudit).not.toHaveBeenCalledWith(expect.objectContaining({ entityId: id }));
  });

  it("keeps tomorrow 08:00 Moscow and a second exact snooze pinned", async () => {
    await insert();
    const ids = await Promise.all([insert({ purpose: "snooze" }), insert({ purpose: "snooze" })]);
    const claimed = await claimDueReminders({ now: new Date("2026-09-03T05:00:37Z"), limit: 100 });
    for (const id of ids) {
      expect(claimed.some((row) => row.id === id)).toBe(true);
      expect((await snapshot(id)).scheduled_at.toISOString()).toBe(desired);
    }
  });

  it("protects the legacy event snooze identity without changing its writer", async () => {
    await insert();
    const id = await insert({ purpose: "pre_event_extra", key: "source:event:snooze:30" });
    await claimDueReminders({ now: new Date(desired), limit: 100 });
    expect((await snapshot(id)).scheduled_at.toISOString()).toBe(desired);
  });

  it("spaces automatic collisions once, and never accumulates drift across runner passes", async () => {
    const ids = await Promise.all([insert(), insert(), insert()]);
    const first = await claimDueReminders({ now: new Date(desired), limit: 100 });
    expect(first).toHaveLength(1);
    const states = await Promise.all(ids.map(snapshot));
    expect(states.map((row) => row.scheduled_at.toISOString()).sort()).toEqual([
      desired, "2026-09-03T05:05:00.000Z", "2026-09-03T05:10:00.000Z",
    ]);
    const shiftedId = ids[states.findIndex((row) => row.scheduled_at.toISOString() === "2026-09-03T05:05:00.000Z")];
    const pinned = await snapshot(shiftedId);
    expect(pinned.payload).toMatchObject({ spacingAlreadyApplied: true, userExplicitSnooze: false });
    expect(new Date(pinned.payload.originalDesiredAt as string).toISOString()).toBe(desired);
    // Even if a new explicit commitment collides with the previously spaced slot,
    // a later pass must not move that occurrence again (including limit=0 passes).
    await insert({ purpose: "snooze", scheduledAt: "2026-09-03T05:05:00Z" });
    for (const now of ["05:05:37", "05:15:13", "05:25:00"]) {
      await claimDueReminders({ now: new Date(`2026-09-03T${now}Z`), limit: 0 });
      expect((await snapshot(shiftedId)).scheduled_at).toEqual(pinned.scheduled_at);
    }
    expect(mocks.writeAudit.mock.calls.filter(([event]) => event.entityId === shiftedId)).toHaveLength(1);
  });

  it.each([{ spacingShiftMinutes: 5 }, { metadata: { spacingReason: "collision_avoidance" } }])(
    "honors already-spaced legacy write-time payload %j", async (payload) => {
      await insert({ purpose: "snooze" });
      const id = await insert({ payload });
      await claimDueReminders({ now: new Date("2026-09-03T05:00:37Z"), limit: 100 });
      expect((await snapshot(id)).scheduled_at.toISOString()).toBe(desired);
    },
  );

  it("does not inherit another occurrence's spacing or snooze commitment", async () => {
    await insert({ purpose: "snooze" });
    const id = await insert({ key: "item:recurring:new", payload: {
      scheduleOccurrenceKey: "item:recurring:old", userExplicitSnooze: true,
      snoozedFrom: "old-reminder", spacingAlreadyApplied: true, spacingShiftMinutes: 5,
    } });
    await claimDueReminders({ now: new Date(desired), limit: 100 });
    expect((await snapshot(id)).scheduled_at.toISOString()).toBe("2026-09-03T05:05:00.000Z");
    expect((await snapshot(id)).payload).toMatchObject({
      scheduleOccurrenceKey: "item:recurring:new", userExplicitSnooze: false, spacingAlreadyApplied: true,
    });
  });
});
