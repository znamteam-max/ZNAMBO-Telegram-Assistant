import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const assistantSchema = pgSchema("assistant");
const assistantTable = assistantSchema.table;

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

const emptyJson = sql`'{}'::jsonb`;
const emptyArrayJson = sql`'[]'::jsonb`;

export const users = assistantTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" }).notNull(),
    telegramUsername: text("telegram_username"),
    firstName: text("first_name"),
    timezone: text("timezone").notNull().default("Europe/Helsinki"),
    locale: text("locale").notNull().default("ru"),
    smartCommitMode: text("smart_commit_mode").notNull().default("auto_low_risk"),
    isOnboarded: boolean("is_onboarded").notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_telegram_user_id_uq").on(table.telegramUserId)],
);

export const telegramMessages = assistantTable(
  "telegram_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    updateId: bigint("update_id", { mode: "bigint" }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    telegramUserId: bigint("telegram_user_id", { mode: "bigint" }),
    chatId: bigint("chat_id", { mode: "bigint" }),
    telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }),
    messageType: text("message_type").notNull().default("unknown"),
    text: text("text"),
    transcript: text("transcript"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default(emptyJson),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_messages_update_id_uq").on(table.updateId),
    index("telegram_messages_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const conversationMessages = assistantTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    telegramMessageId: uuid("telegram_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    role: text("role").notNull(),
    messageType: text("message_type").notNull().default("text"),
    text: text("text"),
    transcript: text("transcript"),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("conversation_messages_user_created_idx").on(table.userId, table.createdAt),
    index("conversation_messages_role_idx").on(table.role),
  ],
);

export const messageAttachments = assistantTable("message_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").references(() => telegramMessages.id, { onDelete: "cascade" }),
  telegramFileId: text("telegram_file_id").notNull(),
  telegramFileUniqueId: text("telegram_file_unique_id"),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  durationSeconds: integer("duration_seconds"),
  status: text("status").notNull().default("processed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const actionPlans = assistantTable(
  "action_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("pending"),
    summary: text("summary"),
    commitMode: text("commit_mode").notNull().default("auto_low_risk"),
    confidencePercent: integer("confidence_percent").notNull().default(50),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("action_plans_idempotency_uq").on(table.idempotencyKey),
    index("action_plans_user_status_idx").on(table.userId, table.status),
    index("action_plans_source_message_idx").on(table.sourceMessageId),
  ],
);

export const actionPlanItems = assistantTable(
  "action_plan_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionPlanId: uuid("action_plan_id")
      .notNull()
      .references(() => actionPlans.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    actionType: text("action_type").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    committedItemId: uuid("committed_item_id").references(() => plannerItems.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("action_plan_items_plan_sequence_uq").on(table.actionPlanId, table.sequence),
    index("action_plan_items_user_status_idx").on(table.userId, table.status),
  ],
);

export const pendingActions = assistantTable(
  "pending_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    actionType: text("action_type").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("pending_actions_idempotency_uq").on(table.idempotencyKey),
    index("pending_actions_user_status_idx").on(table.userId, table.status),
  ],
);

export const plannerItems = assistantTable(
  "planner_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pendingActionId: uuid("pending_action_id").references(() => pendingActions.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("active"),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    timezone: text("timezone").notNull().default("Europe/Helsinki"),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    priority: integer("priority").notNull().default(3),
    source: text("source").notNull().default("telegram"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("planner_items_pending_action_uq").on(table.pendingActionId),
    index("planner_items_user_start_idx").on(table.userId, table.startAt),
    index("planner_items_user_due_idx").on(table.userId, table.dueAt),
    index("planner_items_user_status_idx").on(table.userId, table.status),
  ],
);

export const taskViewStates = assistantTable(
  "task_view_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("current"),
    title: text("title").notNull(),
    itemIds: jsonb("item_ids").$type<string[]>().notNull().default(emptyArrayJson),
    itemsSnapshot: jsonb("items_snapshot").$type<Record<string, unknown>[]>().notNull().default(emptyArrayJson),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("task_view_states_user_created_idx").on(table.userId, table.createdAt),
    index("task_view_states_user_scope_idx").on(table.userId, table.scope),
  ],
);

export const itemSyncState = assistantTable(
  "item_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plannerItemId: uuid("planner_item_id")
      .notNull()
      .references(() => plannerItems.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("google_calendar"),
    externalId: text("external_id"),
    status: text("status").notNull().default("not_synced"),
    lastError: text("last_error"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("item_sync_state_item_provider_uq").on(table.plannerItemId, table.provider),
  ],
);

export const reminders = assistantTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    plannerItemId: uuid("planner_item_id").references(() => plannerItems.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    idempotencyKey: text("idempotency_key"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    repeatUntilAck: boolean("repeat_until_ack").notNull().default(false),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    parentReminderId: uuid("parent_reminder_id"),
    recurrenceKey: text("recurrence_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("reminders_item_type_time_uq").on(
      table.plannerItemId,
      table.type,
      table.scheduledAt,
    ),
    uniqueIndex("reminders_idempotency_key_uq").on(table.idempotencyKey),
    index("reminders_due_idx").on(table.status, table.scheduledAt),
    index("reminders_user_idx").on(table.userId),
    index("reminders_ack_idx").on(table.userId, table.repeatUntilAck, table.ackedAt),
  ],
);

export const reminderDeliveries = assistantTable(
  "reminder_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reminderId: uuid("reminder_id").references(() => reminders.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "bigint" }),
    error: text("error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(emptyJson),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("reminder_deliveries_reminder_idx").on(table.reminderId),
    index("reminder_deliveries_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const memories = assistantTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull().default("active"),
    sourceMessageId: uuid("source_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    searchTags: jsonb("search_tags").$type<string[]>().notNull().default(emptyArrayJson),
    ...timestamps,
  },
  (table) => [index("memories_user_status_idx").on(table.userId, table.status)],
);

export const memoryFacts = assistantTable(
  "memory_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull().default("project"),
    content: text("content").notNull(),
    source: text("source").notNull().default("planner"),
    status: text("status").notNull().default("active"),
    confidencePercent: integer("confidence_percent").notNull().default(70),
    sourceMessageId: uuid("source_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    embedding: jsonb("embedding").$type<number[] | null>(),
    searchTags: jsonb("search_tags").$type<string[]>().notNull().default(emptyArrayJson),
    ...timestamps,
  },
  (table) => [
    index("memory_facts_user_status_idx").on(table.userId, table.status),
    index("memory_facts_category_idx").on(table.category),
  ],
);

export const conversationSummaries = assistantTable(
  "conversation_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    summary: text("summary").notNull(),
    sourceMessageIds: jsonb("source_message_ids").$type<string[]>().notNull().default(emptyArrayJson),
    ...timestamps,
  },
  (table) => [index("conversation_summaries_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const googleCalendarConnections = assistantTable(
  "google_calendar_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    googleEmail: text("google_email"),
    calendarId: text("calendar_id").notNull().default("primary"),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    status: text("status").notNull().default("connected"),
    ...timestamps,
  },
  (table) => [uniqueIndex("google_calendar_connections_user_uq").on(table.userId)],
);

export const calendarSyncJobs = assistantTable(
  "calendar_sync_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    plannerItemId: uuid("planner_item_id").references(() => plannerItems.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(emptyJson),
    ...timestamps,
  },
  (table) => [
    index("calendar_sync_jobs_status_idx").on(table.status, table.nextAttemptAt),
    index("calendar_sync_jobs_item_idx").on(table.plannerItemId),
  ],
);

export const auditLog = assistantTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default(emptyJson),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_log_user_created_idx").on(table.userId, table.createdAt)],
);

export const agentActions = assistantTable(
  "agent_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").references(() => telegramMessages.id, {
      onDelete: "set null",
    }),
    actionType: text("action_type").notNull(),
    status: text("status").notNull().default("completed"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default(emptyJson),
    output: jsonb("output").$type<Record<string, unknown>>().notNull().default(emptyJson),
    undoPayload: jsonb("undo_payload").$type<Record<string, unknown>>().notNull().default(emptyJson),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_actions_user_created_idx").on(table.userId, table.createdAt),
    index("agent_actions_source_message_idx").on(table.sourceMessageId),
  ],
);

export type User = typeof users.$inferSelect;
export type PlannerItem = typeof plannerItems.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type PendingAction = typeof pendingActions.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type MemoryFact = typeof memoryFacts.$inferSelect;
export type ActionPlanRecord = typeof actionPlans.$inferSelect;
export type ActionPlanItemRecord = typeof actionPlanItems.$inferSelect;
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type ReminderDelivery = typeof reminderDeliveries.$inferSelect;
export type GoogleCalendarConnection = typeof googleCalendarConnections.$inferSelect;
export type TaskViewState = typeof taskViewStates.$inferSelect;
export type AgentAction = typeof agentActions.$inferSelect;
