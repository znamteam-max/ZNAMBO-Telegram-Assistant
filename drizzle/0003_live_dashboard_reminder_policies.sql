ALTER TABLE "assistant"."planner_items" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;
ALTER TABLE "assistant"."planner_items" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
ALTER TABLE "assistant"."planner_items" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "assistant"."planner_items" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'active';
ALTER TABLE "assistant"."planner_items" ADD COLUMN IF NOT EXISTS "source_policy_id" uuid;

ALTER TABLE "assistant"."reminders" ADD COLUMN IF NOT EXISTS "policy_id" uuid;
ALTER TABLE "assistant"."reminders" ADD COLUMN IF NOT EXISTS "purpose" text;
ALTER TABLE "assistant"."reminders" ADD COLUMN IF NOT EXISTS "menu_type" text;
ALTER TABLE "assistant"."reminders" ADD COLUMN IF NOT EXISTS "auto_delete_after_response" boolean DEFAULT true NOT NULL;
ALTER TABLE "assistant"."reminders" ADD COLUMN IF NOT EXISTS "superseded_by_message_id" bigint;

CREATE TABLE IF NOT EXISTS "assistant"."reminder_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "item_id" uuid,
  "title" text NOT NULL,
  "category" text NOT NULL,
  "policy_type" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "timezone" text NOT NULL,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "next_fire_at" timestamp with time zone,
  "recurrence_rule" text,
  "interval_minutes" integer,
  "require_ack" boolean DEFAULT false NOT NULL,
  "max_occurrences" integer,
  "quiet_hours" jsonb,
  "escalation_policy" jsonb,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "assistant"."reminder_policy_occurrences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "policy_id" uuid NOT NULL,
  "reminder_id" uuid,
  "scheduled_for" timestamp with time zone NOT NULL,
  "delivered_at" timestamp with time zone,
  "acked_at" timestamp with time zone,
  "skipped_at" timestamp with time zone,
  "status" text DEFAULT 'scheduled' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS "assistant"."live_dashboards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "chat_id" text NOT NULL,
  "message_id" integer NOT NULL,
  "dashboard_type" text DEFAULT 'main' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "expires_at" timestamp with time zone,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "assistant"."telegram_message_registry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "chat_id" text NOT NULL,
  "message_id" integer NOT NULL,
  "purpose" text NOT NULL,
  "related_item_id" uuid,
  "related_reminder_id" uuid,
  "status" text DEFAULT 'active' NOT NULL,
  "delete_after" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "assistant"."reminder_policies" ADD CONSTRAINT "reminder_policies_user_id_users_id_fk"
 FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "assistant"."reminder_policies" ADD CONSTRAINT "reminder_policies_item_id_planner_items_id_fk"
 FOREIGN KEY ("item_id") REFERENCES "assistant"."planner_items"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "assistant"."reminder_policy_occurrences" ADD CONSTRAINT "reminder_policy_occurrences_policy_id_fk"
 FOREIGN KEY ("policy_id") REFERENCES "assistant"."reminder_policies"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "assistant"."reminder_policy_occurrences" ADD CONSTRAINT "reminder_policy_occurrences_reminder_id_fk"
 FOREIGN KEY ("reminder_id") REFERENCES "assistant"."reminders"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "assistant"."live_dashboards" ADD CONSTRAINT "live_dashboards_user_id_users_id_fk"
 FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "assistant"."telegram_message_registry" ADD CONSTRAINT "telegram_message_registry_user_id_users_id_fk"
 FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "assistant"."telegram_message_registry" ADD CONSTRAINT "telegram_message_registry_related_item_id_fk"
 FOREIGN KEY ("related_item_id") REFERENCES "assistant"."planner_items"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "assistant"."telegram_message_registry" ADD CONSTRAINT "telegram_message_registry_related_reminder_id_fk"
 FOREIGN KEY ("related_reminder_id") REFERENCES "assistant"."reminders"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "assistant"."reminders" ADD CONSTRAINT "reminders_policy_id_fk"
 FOREIGN KEY ("policy_id") REFERENCES "assistant"."reminder_policies"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
 ALTER TABLE "assistant"."planner_items" ADD CONSTRAINT "planner_items_source_policy_id_fk"
 FOREIGN KEY ("source_policy_id") REFERENCES "assistant"."reminder_policies"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "reminders_policy_idx" ON "assistant"."reminders" ("policy_id");
CREATE INDEX IF NOT EXISTS "reminder_policies_user_status_idx" ON "assistant"."reminder_policies" ("user_id", "status");
CREATE INDEX IF NOT EXISTS "reminder_policies_next_fire_idx" ON "assistant"."reminder_policies" ("status", "next_fire_at");
CREATE INDEX IF NOT EXISTS "reminder_policies_item_idx" ON "assistant"."reminder_policies" ("item_id");
CREATE UNIQUE INDEX IF NOT EXISTS "reminder_policy_occurrences_policy_time_uq" ON "assistant"."reminder_policy_occurrences" ("policy_id", "scheduled_for");
CREATE INDEX IF NOT EXISTS "reminder_policy_occurrences_status_idx" ON "assistant"."reminder_policy_occurrences" ("status", "scheduled_for");
CREATE INDEX IF NOT EXISTS "live_dashboards_user_chat_status_idx" ON "assistant"."live_dashboards" ("user_id", "chat_id", "status");
CREATE INDEX IF NOT EXISTS "live_dashboards_created_idx" ON "assistant"."live_dashboards" ("created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_message_registry_chat_message_uq" ON "assistant"."telegram_message_registry" ("chat_id", "message_id");
CREATE INDEX IF NOT EXISTS "telegram_message_registry_item_idx" ON "assistant"."telegram_message_registry" ("related_item_id", "status");
CREATE INDEX IF NOT EXISTS "telegram_message_registry_purpose_idx" ON "assistant"."telegram_message_registry" ("chat_id", "purpose", "status");
