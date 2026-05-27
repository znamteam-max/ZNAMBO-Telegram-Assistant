CREATE SCHEMA IF NOT EXISTS "assistant";
--> statement-breakpoint
CREATE TABLE "assistant"."audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant"."google_calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"google_email" text,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"status" text DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant"."item_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"planner_item_id" uuid NOT NULL,
	"provider" text DEFAULT 'google_calendar' NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'not_synced' NOT NULL,
	"last_error" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant"."memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source_message_id" uuid,
	"search_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant"."message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid,
	"telegram_file_id" text NOT NULL,
	"telegram_file_unique_id" text,
	"mime_type" text,
	"file_size" integer,
	"duration_seconds" integer,
	"status" text DEFAULT 'processed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant"."pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_message_id" uuid,
	"action_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant"."planner_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pending_action_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"timezone" text DEFAULT 'Europe/Helsinki' NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"priority" integer DEFAULT 3 NOT NULL,
	"source" text DEFAULT 'telegram' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant"."reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"planner_item_id" uuid,
	"type" text NOT NULL,
	"idempotency_key" text,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"telegram_message_id" bigint,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant"."telegram_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"update_id" bigint NOT NULL,
	"user_id" uuid,
	"telegram_user_id" bigint,
	"chat_id" bigint,
	"telegram_message_id" bigint,
	"message_type" text DEFAULT 'unknown' NOT NULL,
	"text" text,
	"transcript" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_username" text,
	"first_name" text,
	"timezone" text DEFAULT 'Europe/Helsinki' NOT NULL,
	"locale" text DEFAULT 'ru' NOT NULL,
	"is_onboarded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant"."audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."item_sync_state" ADD CONSTRAINT "item_sync_state_planner_item_id_planner_items_id_fk" FOREIGN KEY ("planner_item_id") REFERENCES "assistant"."planner_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."memories" ADD CONSTRAINT "memories_source_message_id_telegram_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "assistant"."telegram_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."message_attachments" ADD CONSTRAINT "message_attachments_message_id_telegram_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "assistant"."telegram_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."pending_actions" ADD CONSTRAINT "pending_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."pending_actions" ADD CONSTRAINT "pending_actions_source_message_id_telegram_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "assistant"."telegram_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."planner_items" ADD CONSTRAINT "planner_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."planner_items" ADD CONSTRAINT "planner_items_pending_action_id_pending_actions_id_fk" FOREIGN KEY ("pending_action_id") REFERENCES "assistant"."pending_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."reminders" ADD CONSTRAINT "reminders_planner_item_id_planner_items_id_fk" FOREIGN KEY ("planner_item_id") REFERENCES "assistant"."planner_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."telegram_messages" ADD CONSTRAINT "telegram_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_user_created_idx" ON "assistant"."audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "google_calendar_connections_user_uq" ON "assistant"."google_calendar_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_sync_state_item_provider_uq" ON "assistant"."item_sync_state" USING btree ("planner_item_id","provider");--> statement-breakpoint
CREATE INDEX "memories_user_status_idx" ON "assistant"."memories" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_actions_idempotency_uq" ON "assistant"."pending_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "pending_actions_user_status_idx" ON "assistant"."pending_actions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "planner_items_pending_action_uq" ON "assistant"."planner_items" USING btree ("pending_action_id");--> statement-breakpoint
CREATE INDEX "planner_items_user_start_idx" ON "assistant"."planner_items" USING btree ("user_id","start_at");--> statement-breakpoint
CREATE INDEX "planner_items_user_due_idx" ON "assistant"."planner_items" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "planner_items_user_status_idx" ON "assistant"."planner_items" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_item_type_time_uq" ON "assistant"."reminders" USING btree ("planner_item_id","type","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_idempotency_key_uq" ON "assistant"."reminders" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "assistant"."reminders" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "reminders_user_idx" ON "assistant"."reminders" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_messages_update_id_uq" ON "assistant"."telegram_messages" USING btree ("update_id");--> statement-breakpoint
CREATE INDEX "telegram_messages_user_created_idx" ON "assistant"."telegram_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_telegram_user_id_uq" ON "assistant"."users" USING btree ("telegram_user_id");
