ALTER TABLE "assistant"."planner_items"
  ADD COLUMN IF NOT EXISTS "snoozed_until" timestamptz;
--> statement-breakpoint
ALTER TABLE "assistant"."reminder_policies"
  ADD COLUMN IF NOT EXISTS "snoozed_until" timestamptz;
--> statement-breakpoint
ALTER TABLE "assistant"."reminder_policies"
  ADD COLUMN IF NOT EXISTS "snooze_scope" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planner_items_snoozed_until_idx"
  ON "assistant"."planner_items" ("snoozed_until");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminder_policies_snoozed_until_idx"
  ON "assistant"."reminder_policies" ("snoozed_until");
