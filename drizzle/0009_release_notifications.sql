CREATE TABLE IF NOT EXISTS "assistant"."release_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "version" text NOT NULL,
  "commit_sha" text NOT NULL,
  "environment" text DEFAULT 'production' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "sent_at" timestamptz,
  "telegram_message_id" bigint,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_error" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_notifications_version_commit_environment_uq"
  ON "assistant"."release_notifications" ("version", "commit_sha", "environment");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_notifications_status_created_idx"
  ON "assistant"."release_notifications" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_notifications_version_sent_idx"
  ON "assistant"."release_notifications" ("version", "sent_at");
