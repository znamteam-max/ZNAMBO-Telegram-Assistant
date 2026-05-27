import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getEnv, requireEnv } from "@/lib/env";

import * as schema from "./schema";

let queryClient: postgres.Sql | null = null;
let db: PostgresJsDatabase<typeof schema> | null = null;

export function getDb() {
  if (!db) {
    const databaseUrl = requireEnv("DATABASE_URL");
    queryClient = postgres(databaseUrl, {
      max: getEnv().NODE_ENV === "production" ? 5 : 1,
      prepare: false,
    });
    db = drizzle(queryClient, { schema });
  }
  return db;
}

export async function closeDb() {
  if (queryClient) {
    await queryClient.end();
    queryClient = null;
    db = null;
  }
}
