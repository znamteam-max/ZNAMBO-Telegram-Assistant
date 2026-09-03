import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Real PostgreSQL SQL semantics, entirely in memory: never reads DATABASE_URL.
export async function createReminderTestDb() {
  const pg = await PGlite.create();
  await pg.exec(`
    create schema assistant;
    create table assistant.reminder_policies (
      id uuid primary key, policy_type text, ends_at timestamptz, snoozed_until timestamptz
    );
    create table assistant.planner_items (id uuid primary key, snoozed_until timestamptz);
    create table assistant.reminders (
      id uuid primary key default gen_random_uuid(), user_id uuid not null,
      planner_item_id uuid, policy_id uuid, type text default 'custom',
      idempotency_key text, scheduled_at timestamptz not null,
      status text default 'pending', claimed_at timestamptz, sent_at timestamptz,
      telegram_message_id bigint, attempt_count integer default 0, last_error text,
      repeat_until_ack boolean default false, acked_at timestamptz,
      parent_reminder_id uuid, recurrence_key text, purpose text default 'reminder',
      menu_type text, auto_delete_after_response boolean default true,
      superseded_by_message_id bigint, payload jsonb not null default '{}',
      created_at timestamptz default now(), updated_at timestamptz default now()
    );
  `);
  const dialect = new PgDialect();
  return {
    pg,
    execute: async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      return (await pg.query(compiled.sql, compiled.params)).rows;
    },
  };
}
