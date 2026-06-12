ALTER TABLE "assistant"."item_sync_state"
  ADD COLUMN IF NOT EXISTS "duration_ms" integer;

DELETE FROM "assistant"."calendar_sync_jobs" older
USING "assistant"."calendar_sync_jobs" newer
WHERE older."planner_item_id" = newer."planner_item_id"
  AND older."provider" = newer."provider"
  AND (
    older."updated_at" < newer."updated_at"
    OR (older."updated_at" = newer."updated_at" AND older."id" < newer."id")
  );

CREATE UNIQUE INDEX IF NOT EXISTS "calendar_sync_jobs_item_provider_uq"
  ON "assistant"."calendar_sync_jobs" ("planner_item_id", "provider");
