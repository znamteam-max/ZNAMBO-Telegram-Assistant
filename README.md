# Personal Telegram Daily Assistant

Приватный Telegram-бот-ежедневник для одного владельца. Он принимает текст, голос, audio, video note и короткие video/mp4, извлекает из них встречи, задачи, тренировки, заметки и подготовку, показывает карточку подтверждения и только после кнопки сохраняет запись, напоминания и, если подключено, событие Google Calendar.

## Архитектура

```text
Telegram
  -> /api/telegram/webhook
  -> grammY middleware: allowlist -> owner -> update idempotency
  -> message/callback handlers
  -> OpenAI Responses / transcription
  -> pending_actions confirmation
  -> planner_items + reminders + memories + audit_log
  -> optional Google Calendar sync

Cloudflare Cron Worker
  -> /api/reminders/run
  -> atomic reminder claim
  -> Telegram notification

Postgres
  -> Drizzle schema + migrations
```

## Что уже входит в MVP

- Next.js App Router API routes for Telegram, reminders, Google OAuth, health and export.
- Drizzle/Postgres schema and migration for users, messages, attachments, pending actions, planner items, reminders, memories, Google Calendar connections, sync state and audit log.
- grammY bot with `/start`, `/today`, `/tomorrow`, `/week`, `/tasks`, `/settings`, `/calendar`, `/export`, `/forget`.
- Confirmation-before-write flow with inline buttons.
- OpenAI Responses API tool call for structured planning proposals.
- OpenAI audio transcription for voice/audio/video note/video, with 20 MB Telegram Bot API guard and 25 MB OpenAI guard.
- Protected reminder dispatcher with atomic `FOR UPDATE SKIP LOCKED` claiming.
- Cloudflare Worker cron project.
- Google Calendar OAuth, encrypted refresh token storage and event sync.
- Vitest coverage for allowlist, idempotency middleware, date conversion, reminder policy, pending action double-click safety, oversized media, agenda ordering and calendar failure preservation.

## Prerequisites

- Node.js 20+.
- PostgreSQL database URL, for example Neon or Supabase Postgres.
- Telegram bot token from BotFather.
- OpenAI API key.
- Vercel project for the Next.js app.
- Cloudflare account for the minute cron Worker.
- Google OAuth credentials are optional until `/calendar` is used.

## Local Setup

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

Fill `.env` with real values before running webhook or database-backed flows.

## Environment

Required for the connected bot:

```env
DATABASE_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
ALLOWED_TELEGRAM_USER_IDS=
OPENAI_API_KEY=
CRON_SECRET=
APP_ENCRYPTION_KEY=
```

Optional until calendar is connected:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
GOOGLE_TOKEN_ENCRYPTION_KEY=
GOOGLE_CALENDAR_ID=primary
```

Models are configurable:

```env
OPENAI_TEXT_MODEL=gpt-4o-mini
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
```

## Database

Schema lives in `src/db/schema.ts`. Migration output lives in `drizzle/`.

```bash
npm run db:generate
npm run db:migrate
```

All business timestamps are stored as UTC `timestamptz`; user-facing interpretation uses the owner's IANA timezone.

## Owner Telegram ID

Safest options:

1. Temporarily message `@userinfobot` or a similar ID helper bot.
2. Or run the bot locally with a temporary allowlist only for testing and inspect Telegram update logs.

Set:

```env
ALLOWED_TELEGRAM_USER_IDS=123456789
```

The bot replies with no private data to users outside the allowlist.

## Telegram Webhook

After deploying the app and setting env vars:

```bash
npm run telegram:webhook
```

It registers:

```text
https://<your-app>/api/telegram/webhook
```

The route validates `x-telegram-bot-api-secret-token` against `TELEGRAM_WEBHOOK_SECRET`.

## Google Calendar

Create OAuth credentials in Google Cloud Console and add this redirect URI:

```text
https://<your-app>/api/google/oauth/callback
```

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `APP_ENCRYPTION_KEY` and preferably `GOOGLE_TOKEN_ENCRYPTION_KEY`.

Then send `/calendar` in Telegram and open the generated authorization link. If Calendar sync fails later, the local item and reminders remain active and sync error is recorded.

## Deploy on Vercel

1. Import the repository into Vercel.
2. Add all production env vars.
3. Ensure `NEXT_PUBLIC_APP_URL` is the production URL.
4. Deploy.
5. Run `npm run telegram:webhook` locally with production env values or call Telegram `setWebhook` manually.

Vercel Hobby cron is not suitable for minute-accurate reminders. Vercel Pro can replace the Cloudflare Worker with a per-minute cron calling `/api/reminders/run`.

## Cloudflare Cron Worker

```bash
cd cloudflare-reminder-worker
npm install
cp wrangler.toml.example wrangler.toml
wrangler secret put CRON_SECRET
wrangler secret put APP_REMINDER_RUN_URL
npm run deploy
```

`APP_REMINDER_RUN_URL` should be:

```text
https://<your-app>/api/reminders/run
```

The Worker calls it once per minute with:

```http
Authorization: Bearer <CRON_SECRET>
```

## Test Reminder Endpoint

```bash
curl -X POST "https://<your-app>/api/reminders/run" \
  -H "Authorization: Bearer <CRON_SECRET>"
```

## Supported Media

- Text messages.
- Telegram voice.
- Audio files.
- Video notes.
- Short video/mp4 when Telegram Bot API can download it.

Limits:

- Telegram standard Bot API download limit: 20 MB.
- OpenAI transcription upload guard in this app: 25 MB.
- Source media is not stored after processing; transcript and metadata are stored.

## Security Notes

- Single-owner allowlist via `ALLOWED_TELEGRAM_USER_IDS`.
- Telegram webhook secret token validation.
- Cron bearer secret validation with timing-safe comparison.
- Google OAuth state is signed and time-limited.
- Google refresh tokens are encrypted at rest.
- Secrets are never intentionally logged; logger redacts token/key/secret-like fields.
- Duplicate Telegram updates are ignored through `telegram_messages.update_id`.
- Duplicate confirmation clicks are protected by pending action status and unique `planner_items.pending_action_id`.
- `/export` requires bearer auth and owner Telegram ID header.
- `/forget` deletes only owner-scoped memories.

## Commands

```bash
npm run dev
npm run build
npm run lint
npm test
npm run db:generate
npm run db:migrate
npm run telegram:webhook
```

## Manual Acceptance

1. Send `Запиши встречу в Winline в четверг в 12`, confirm, then check `/week`.
2. Send a short Russian voice with the same intent, confirm, then check `/week`.
3. Create a task with due time, run `/api/reminders/run`, verify Telegram reminder.
4. Connect Google Calendar with `/calendar`, confirm an event, verify calendar event.
5. Send `/today` and `/tasks`.
6. Send a post-meeting voice summary; bot should transcribe and propose follow-up action.
7. Try a message from an unauthorized account; it should not expose private data.

## Known MVP Limitations

- Natural language editing/deleting existing items is guarded but not fully implemented; ambiguous changes ask for clarification.
- There is no web admin panel yet.
- Semantic memory retrieval uses simple recent-memory context, not pgvector.
- Daily digest creation is handled by the reminder runner and idempotency keys, not a separate UI.
- Large meeting videos require a future Local Bot API Server or external upload flow.

## Documentation Anchors

- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
- [OpenAI function calling](https://platform.openai.com/docs/guides/function-calling)
- [OpenAI speech-to-text](https://platform.openai.com/docs/guides/speech-to-text)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Google Calendar events](https://developers.google.com/workspace/calendar/api/guides/create-events)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
