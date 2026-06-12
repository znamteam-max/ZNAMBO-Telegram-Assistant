CREATE TABLE IF NOT EXISTS "assistant"."external_calendar_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "provider" text DEFAULT 'yandex' NOT NULL,
  "calendar_label" text DEFAULT 'Личный' NOT NULL,
  "calendar_object_url" text NOT NULL,
  "uid" text NOT NULL,
  "etag" text,
  "summary" text NOT NULL,
  "description" text,
  "location" text,
  "start_at" timestamptz NOT NULL,
  "end_at" timestamptz,
  "timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
  "is_recurring" boolean DEFAULT false NOT NULL,
  "recurrence_rule" text,
  "recurrence_id" text DEFAULT '' NOT NULL,
  "exdates" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source" text DEFAULT 'yandex_external' NOT NULL,
  "hidden_at" timestamptz,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "external_calendar_events_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_calendar_events_user_object_recurrence_uq"
  ON "assistant"."external_calendar_events" ("user_id", "calendar_object_url", "recurrence_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_calendar_events_user_start_idx"
  ON "assistant"."external_calendar_events" ("user_id", "start_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_calendar_events_user_uid_idx"
  ON "assistant"."external_calendar_events" ("user_id", "uid");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."calendar_import_state" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "provider" text DEFAULT 'yandex' NOT NULL,
  "last_import_at" timestamptz,
  "imported_events_count" integer DEFAULT 0 NOT NULL,
  "recurring_events_count" integer DEFAULT 0 NOT NULL,
  "external_events_visible" integer DEFAULT 0 NOT NULL,
  "possible_duplicates" integer DEFAULT 0 NOT NULL,
  "last_import_error_class" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "calendar_import_state_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade
);
