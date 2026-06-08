ALTER TABLE "assistant"."users" ADD COLUMN IF NOT EXISTS "quiet_hours_start" text DEFAULT '00:00' NOT NULL;
ALTER TABLE "assistant"."users" ADD COLUMN IF NOT EXISTS "quiet_hours_end" text DEFAULT '07:30' NOT NULL;

ALTER TABLE "assistant"."reminder_policies" ADD COLUMN IF NOT EXISTS "window_end_inclusive" boolean DEFAULT true NOT NULL;
ALTER TABLE "assistant"."reminder_policies" ADD COLUMN IF NOT EXISTS "catch_up_mode" text DEFAULT 'one_immediate_then_resume' NOT NULL;

CREATE TABLE IF NOT EXISTS "assistant"."scheduler_runtime_health" (
  "key" text PRIMARY KEY NOT NULL,
  "last_runner_started_at" timestamp with time zone,
  "last_runner_finished_at" timestamp with time zone,
  "last_runner_claimed" integer DEFAULT 0 NOT NULL,
  "last_runner_sent" integer DEFAULT 0 NOT NULL,
  "last_runner_failed" integer DEFAULT 0 NOT NULL,
  "last_policy_reconcile_at" timestamp with time zone,
  "last_policy_reconcile_checked" integer DEFAULT 0 NOT NULL,
  "last_policy_reconcile_created" integer DEFAULT 0 NOT NULL,
  "last_scheduler_hit_at" timestamp with time zone,
  "last_error" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

INSERT INTO "assistant"."scheduler_runtime_health" ("key")
VALUES ('reminder_runner')
ON CONFLICT ("key") DO NOTHING;

CREATE INDEX IF NOT EXISTS "reminder_policy_occurrences_reminder_idx"
  ON "assistant"."reminder_policy_occurrences" ("reminder_id");

CREATE INDEX IF NOT EXISTS "reminders_policy_status_time_idx"
  ON "assistant"."reminders" ("policy_id", "status", "scheduled_at");
