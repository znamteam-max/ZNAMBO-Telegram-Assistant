import postgres from "postgres";

const databaseUrl = (await readStdin()).trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required on stdin");

const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  ssl: databaseUrl.includes("sslmode=require") ? "require" : undefined,
  connect_timeout: 12,
  idle_timeout: 5,
});

try {
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'assistant'
      and (
        (table_name = 'planner_items' and column_name = 'snoozed_until')
        or (
          table_name = 'reminder_policies'
          and column_name in ('snoozed_until', 'snooze_scope')
        )
      )
    order by table_name, column_name
  `;
  console.log(
    JSON.stringify({
      ok: columns.length === 3,
      columns: columns.map((column) => `${column.table_name}.${column.column_name}`),
    }),
  );
} finally {
  await sql.end({ timeout: 2 });
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
