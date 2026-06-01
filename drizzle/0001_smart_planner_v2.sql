ALTER TABLE "assistant"."users" ADD COLUMN IF NOT EXISTS "smart_commit_mode" text DEFAULT 'auto_low_risk' NOT NULL;
--> statement-breakpoint
ALTER TABLE "assistant"."reminders" ADD COLUMN IF NOT EXISTS "repeat_until_ack" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "assistant"."reminders" ADD COLUMN IF NOT EXISTS "acked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "assistant"."reminders" ADD COLUMN IF NOT EXISTS "parent_reminder_id" uuid;
--> statement-breakpoint
ALTER TABLE "assistant"."reminders" ADD COLUMN IF NOT EXISTS "recurrence_key" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"telegram_message_id" uuid,
	"role" text NOT NULL,
	"message_type" text DEFAULT 'text' NOT NULL,
	"text" text,
	"transcript" text,
	"summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."action_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_message_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary" text,
	"commit_mode" text DEFAULT 'auto_low_risk' NOT NULL,
	"confidence_percent" integer DEFAULT 50 NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."action_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_plan_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"action_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"committed_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."reminder_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reminder_id" uuid,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"telegram_message_id" bigint,
	"error" text,
	"delivered_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."memory_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text DEFAULT 'project' NOT NULL,
	"content" text NOT NULL,
	"source" text DEFAULT 'planner' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"confidence_percent" integer DEFAULT 70 NOT NULL,
	"source_message_id" uuid,
	"embedding" jsonb,
	"search_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."conversation_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"summary" text NOT NULL,
	"source_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."calendar_sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"planner_item_id" uuid,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."conversation_messages" ADD CONSTRAINT "conversation_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."conversation_messages" ADD CONSTRAINT "conversation_messages_telegram_message_id_telegram_messages_id_fk" FOREIGN KEY ("telegram_message_id") REFERENCES "assistant"."telegram_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."action_plans" ADD CONSTRAINT "action_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."action_plans" ADD CONSTRAINT "action_plans_source_message_id_telegram_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "assistant"."telegram_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."action_plan_items" ADD CONSTRAINT "action_plan_items_action_plan_id_action_plans_id_fk" FOREIGN KEY ("action_plan_id") REFERENCES "assistant"."action_plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."action_plan_items" ADD CONSTRAINT "action_plan_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."action_plan_items" ADD CONSTRAINT "action_plan_items_committed_item_id_planner_items_id_fk" FOREIGN KEY ("committed_item_id") REFERENCES "assistant"."planner_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "assistant"."reminders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."memory_facts" ADD CONSTRAINT "memory_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."memory_facts" ADD CONSTRAINT "memory_facts_source_message_id_telegram_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "assistant"."telegram_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."conversation_summaries" ADD CONSTRAINT "conversation_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."calendar_sync_jobs" ADD CONSTRAINT "calendar_sync_jobs_planner_item_id_planner_items_id_fk" FOREIGN KEY ("planner_item_id") REFERENCES "assistant"."planner_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "action_plans_idempotency_uq" ON "assistant"."action_plans" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_plans_user_status_idx" ON "assistant"."action_plans" USING btree ("user_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_plans_source_message_idx" ON "assistant"."action_plans" USING btree ("source_message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "action_plan_items_plan_sequence_uq" ON "assistant"."action_plan_items" USING btree ("action_plan_id","sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_plan_items_user_status_idx" ON "assistant"."action_plan_items" USING btree ("user_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_messages_user_created_idx" ON "assistant"."conversation_messages" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_messages_role_idx" ON "assistant"."conversation_messages" USING btree ("role");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_facts_user_status_idx" ON "assistant"."memory_facts" USING btree ("user_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_facts_category_idx" ON "assistant"."memory_facts" USING btree ("category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_summaries_user_updated_idx" ON "assistant"."conversation_summaries" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminders_ack_idx" ON "assistant"."reminders" USING btree ("user_id","repeat_until_ack","acked_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminder_deliveries_reminder_idx" ON "assistant"."reminder_deliveries" USING btree ("reminder_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminder_deliveries_user_created_idx" ON "assistant"."reminder_deliveries" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_sync_jobs_status_idx" ON "assistant"."calendar_sync_jobs" USING btree ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_sync_jobs_item_idx" ON "assistant"."calendar_sync_jobs" USING btree ("planner_item_id");
