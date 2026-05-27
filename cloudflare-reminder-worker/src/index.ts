export interface Env {
  APP_REMINDER_RUN_URL: string;
  CRON_SECRET: string;
}

const worker = {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(callReminderEndpoint(env));
  },

  async fetch(_request: Request, env: Env) {
    const result = await callReminderEndpoint(env);
    return Response.json(result);
  },
};

export default worker;

async function callReminderEndpoint(env: Env) {
  const response = await fetch(env.APP_REMINDER_RUN_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CRON_SECRET}`,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Reminder endpoint failed: ${response.status} ${text}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { ok: true, raw: text };
  }
}
