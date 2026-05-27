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

export type User = typeof users.$inferSelect;
export type PlannerItem = typeof plannerItems.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type PendingAction = typeof pendingActions.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type GoogleCalendarConnection = typeof googleCalendarConnections.$inferSelect;
