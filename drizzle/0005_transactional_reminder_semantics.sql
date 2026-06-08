ALTER TABLE "assistant"."reminder_policies"
  ADD COLUMN IF NOT EXISTS "on_window_end" text DEFAULT 'expire_silently' NOT NULL;

CREATE TABLE IF NOT EXISTS "assistant"."runtime_locks" (
  "key" text PRIMARY KEY NOT NULL,
  "owner_token" text NOT NULL,
  "locked_until" timestamp with time zone NOT NULL,
  "acquired_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "reminder_policy_occurrences_reminder_uq"
  ON "assistant"."reminder_policy_occurrences" ("reminder_id")
  WHERE "reminder_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "runtime_locks_expiry_idx"
  ON "assistant"."runtime_locks" ("locked_until");
