import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = process.env.NEXT_PUBLIC_APP_URL;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token || !appUrl || !secret) {
  throw new Error("Set TELEGRAM_BOT_TOKEN, NEXT_PUBLIC_APP_URL and TELEGRAM_WEBHOOK_SECRET first.");
}

const webhookUrl = `${appUrl.replace(/\/$/, "")}/api/telegram/webhook`;
const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  }),
});

const body = await response.json();
if (!response.ok || !body.ok) {
  throw new Error(`Telegram setWebhook failed: ${JSON.stringify(body)}`);
}

console.log(`Webhook registered: ${webhookUrl}`);
