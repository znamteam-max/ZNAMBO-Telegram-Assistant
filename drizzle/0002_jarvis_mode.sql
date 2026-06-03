CREATE TABLE IF NOT EXISTS "assistant"."task_view_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "scope" text DEFAULT 'current' NOT NULL,
  "title" text NOT NULL,
  "item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "items_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "assistant"."task_view_states"
   ADD CONSTRAINT "task_view_states_user_id_users_id_fk"
   FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "task_view_states_user_created_idx"
  ON "assistant"."task_view_states" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "task_view_states_user_scope_idx"
  ON "assistant"."task_view_states" ("user_id", "scope");

CREATE TABLE IF NOT EXISTS "assistant"."agent_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "source_message_id" uuid,
  "action_type" text NOT NULL,
  "status" text DEFAULT 'completed' NOT NULL,
  "input" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "output" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "undo_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "assistant"."agent_actions"
   ADD CONSTRAINT "agent_actions_user_id_users_id_fk"
   FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "assistant"."agent_actions"
   ADD CONSTRAINT "agent_actions_source_message_id_telegram_messages_id_fk"
   FOREIGN KEY ("source_message_id") REFERENCES "assistant"."telegram_messages"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "agent_actions_user_created_idx"
  ON "assistant"."agent_actions" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "agent_actions_source_message_idx"
  ON "assistant"."agent_actions" ("source_message_id");
