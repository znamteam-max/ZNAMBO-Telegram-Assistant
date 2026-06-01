import fs from "node:fs/promises";
import postgres from "postgres";

const migrationPath = process.argv[2];
if (!migrationPath) {
  throw new Error("Usage: tsx scripts/apply-sql-migration-from-stdin.ts <migration.sql>");
}

const databaseUrl = (await readStdin()).trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required on stdin");

const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  ssl: databaseUrl.includes("sslmode=require") ? "require" : undefined,
});

try {
  const migration = await fs.readFile(migrationPath, "utf8");
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const [index, statement] of statements.entries()) {
    await retry(async () => {
      await sql.unsafe(statement);
    }, `statement ${index + 1}/${statements.length}`);
  }

  const tables = await sql<{ table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = 'assistant'
    order by table_name
  `;
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'assistant'
      and (
        table_name in (
          'users',
          'reminders',
          'action_plans',
          'action_plan_items',
          'conversation_messages',
          'memory_facts',
          'conversation_summaries',
          'reminder_deliveries',
          'calendar_sync_jobs'
        )
      )
    order by table_name, column_name
  `;

  console.log(JSON.stringify({ ok: true, tableCount: tables.length, tables, columns }, null, 2));
} finally {
  await sql.end();
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function retry(fn: () => Promise<void>, label: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error(`${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
