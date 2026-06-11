# Personal Telegram Daily Assistant

Current application version: `2.5.2`.

Release summaries are stored as one file per version in [`versions/`](./versions/README.md).

Приватный Telegram-бот-ежедневник для одного владельца. V2 работает как smart AI planner: принимает текст, голос, audio, video note и короткие video/mp4, сохраняет историю и расшифровки, достает контекст из памяти, извлекает несколько действий из одного сообщения и создает встречи, задачи, подготовку, тренировки, tentative-события, recurring reminders и repeat-until-ack напоминания.

## Архитектура

```text
Telegram
  -> /api/telegram/webhook
  -> grammY middleware: allowlist -> owner -> update idempotency
  -> message/callback handlers
  -> conversation history + transcript storage
  -> active context retrieval: memory facts + summaries + recent messages + tasks
  -> OpenAI Responses / transcription
  -> ActionPlan with multiple action_plan_items
  -> smart commit or confirmation
  -> planner_items + reminder_policies + policy_occurrences + reminders
  -> live dashboard + Telegram message lifecycle registry
  -> best-effort Google/Yandex Calendar sync

External minute scheduler: cron-job.org or Cloudflare Worker
  -> /api/reminders/run
  -> reconcile active reminder policies
  -> atomic reminder claim
  -> Telegram notification
  -> advance from occurrence.scheduledFor without interval drift

Postgres
  -> Drizzle schema + migrations
```

## Что уже входит в V2

- Next.js App Router API routes for Telegram, reminders, calendar integrations, health and export.
- Drizzle/Postgres schema and migrations for users, messages, conversation history, action plans, action plan items, planner items, reminders, reminder deliveries, memory facts, summaries, Google Calendar connections, sync state and audit log.
- grammY bot with `/start`, `/dashboard`, `/today`, `/tomorrow`, `/week`, `/tasks`, `/reminders`, `/longterm`, `/cleanup_chat`, `/settings`, `/calendar`, `/remindertest`, `/export`, `/forget`.
- Jarvis Mode agent loop before planner capture: plan views, numbered task view state, delete/done by displayed indices, yesterday review, cleanup and undo.
- Smart commit mode: `confirm_all`, `auto_low_risk`, `auto_all_with_undo`.
- Multi-action `ActionPlan` instead of a single mechanical pending action.
- OpenAI Responses API tool call for multi-action planning, with deterministic heuristic fallback for tests and obvious cases.
- OpenAI audio transcription for voice/audio/video note/video, with 20 MB Telegram Bot API guard and 25 MB OpenAI guard.
- Protected reminder dispatcher with atomic `FOR UPDATE SKIP LOCKED` claiming, delivery records and repeat-until-ack scheduling.
- Reminder Policy Engine for one-time, before-event, post-event reaction, interval-window, recurring, nag-until-ack and long-term rules.
- Policy reconciler that recreates a missing next occurrence/reminder idempotently before each runner claim.
- Catch-up without bursts, interval-grid scheduling, inclusive window ends and user/policy quiet hours.
- Scheduler observability through `/cronhealth`, `/policydebug` and safe `/api/health` fields.
- Live Plan Dashboard that retires the previous dashboard and sends one current bottom-most control center after mutations.
- Telegram message registry for deleting or disabling stale reminder cards, item menus and dashboards.
- External minute scheduler support through cron-job.org or the optional Cloudflare Worker project.
- Google Calendar OAuth, encrypted refresh token storage and event sync.
- Yandex Calendar sync via CalDAV as a best-effort calendar provider. Calendar failure does not block DB records or Telegram reminders.
- Vitest coverage for allowlist, idempotency middleware, date conversion, reminder policy repair/reconciliation, catch-up, interval drift, pending action double-click safety, oversized media, agenda ordering, calendar failure preservation and V2 planner acceptance cases.

## Prerequisites

- Node.js 20+.
- PostgreSQL database URL, for example Neon or Supabase Postgres.
- Telegram bot token from BotFather.
- OpenAI API key.
- Vercel project for the Next.js app.
- External scheduler for the minute reminder runner. Production currently uses cron-job.org; Cloudflare Worker is optional.
- Google OAuth credentials are optional unless `CALENDAR_PROVIDER=google` is used.

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
CALENDAR_PROVIDER=none
YANDEX_CALDAV_URL=https://caldav.yandex.ru
YANDEX_CALDAV_USERNAME=
YANDEX_CALDAV_APP_PASSWORD=
YANDEX_CALDAV_CALENDAR_URL=
YANDEX_CALENDAR_URL=
```

Models are configurable:

```env
OPENAI_TEXT_MODEL=gpt-4o-mini
OPENAI_PLANNER_MODEL=gpt-4o-mini
OPENAI_MEMORY_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
ENABLE_AGENT_PLANNER_V2=true
JARVIS_MODE_ENABLED=true
ENABLE_MEMORY_EMBEDDINGS=false
SMART_COMMIT_MODE=auto_low_risk
DEFAULT_MORNING_REMINDER_TIME=09:30
```

## Database

Schema lives in `src/db/schema.ts`. Migration output lives in `drizzle/`.

```bash
npm run db:generate
npm run db:migrate
```

All business timestamps are stored as UTC `timestamptz`; user-facing interpretation uses the owner's IANA timezone.

Jarvis Mode adds:

```text
assistant.task_view_states
assistant.agent_actions
assistant.live_dashboards
assistant.telegram_message_registry
assistant.reminder_policies
assistant.reminder_policy_occurrences
```

Apply `drizzle/0003_live_dashboard_reminder_policies.sql` before enabling V2.4 production traffic.

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

Use `/calendar status` for current status and `/calendar retry` for best-effort retry messaging.

## Yandex Calendar

Set:

```env
CALENDAR_PROVIDER=yandex
YANDEX_CALDAV_URL=https://caldav.yandex.ru
YANDEX_CALDAV_USERNAME=<yandex-email>
YANDEX_CALDAV_APP_PASSWORD=<app-password>
```

`YANDEX_CALDAV_CALENDAR_URL` is optional. If omitted, the app discovers the first CalDAV calendar collection through `current-user-principal` and `calendar-home-set`.

`YANDEX_CALENDAR_URL` can store the human web URL for reference; it is not used for CalDAV unless it starts with `https://caldav.`.

## Deploy on Vercel

1. Import the repository into Vercel.
2. Add all production env vars.
3. Ensure `NEXT_PUBLIC_APP_URL` is the production URL.
4. Deploy.
5. Run `npm run telegram:webhook` locally with production env values or call Telegram `setWebhook` manually.

Vercel Hobby cron is not suitable for minute-accurate reminders. Production can use cron-job.org, Cloudflare Worker, or Vercel Pro cron to call `/api/reminders/run` once per minute.

## cron-job.org Scheduler

Production currently uses cron-job.org as the minute scheduler:

```text
POST https://<your-app>/api/reminders/run
Authorization: Bearer <CRON_SECRET>
```

The cron-job.org run should return `200 OK` with a JSON result containing `ok`, `claimed`, `sent`, and `failed`.

## Cloudflare Cron Worker Optional Fallback

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

Telegram smoke test:

```text
/remindertest 2
```

The bot creates a real reminder due in 2 minutes. It will arrive only if cron-job.org, Cloudflare Worker, or another scheduler calls `/api/reminders/run` every minute with the correct `CRON_SECRET`.

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

1. Send `/start`, then `/remindertest 2`, and verify a Telegram reminder in 2 minutes.
2. Send `Сегодня созвон в 17.00 по русскому баскетболу`, then check `/today`.
3. Send the long Zoom + setup + tentative call + Z2 training message from the V2 task; the bot should produce one multi-action summary.
4. Send `Напоминать о рилзах по F1 и MMA каждое утро в понедельник, вторник, среду и пятницу`; check `/tasks`.
5. Send the San Antonio vs Oklahoma night-match message; it must schedule `03:30`, not `15:30`.
6. Send `Каждое утро напоминай мне пить витамины, пока я не подтвержу`; check repeat-until-ack buttons.
7. Send `/calendar status`; calendar errors must not block the saved plan.
8. Send `Дай план целиком`, then `удалить 7-12 и 14`; the bot must use the last numbered list instead of creating a new task.
9. Send `Хочу отметить что выполнено вчера`; the bot must open yesterday review without creating a task.
10. Use `/cleanup_garbage` and `/undo` for cleanup smoke testing.

## Known Limitations

- Natural language editing/deleting existing items is guarded but not fully implemented; ambiguous changes ask for clarification.
- There is no web admin panel yet.
- Semantic memory retrieval uses memory facts, summaries and recent messages. Embeddings are env-configured but pgvector storage is not required for this MVP.
- Calendar retry queue schema exists, but fully automated retry processing is still intentionally best-effort.
- Daily digest creation is handled by the reminder runner and idempotency keys, not a separate UI.
- Large meeting videos require a future Local Bot API Server or external upload flow.

## Documentation Anchors

- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
- [OpenAI function calling](https://platform.openai.com/docs/guides/function-calling)
- [OpenAI speech-to-text](https://platform.openai.com/docs/guides/speech-to-text)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Google Calendar events](https://developers.google.com/workspace/calendar/api/guides/create-events)
- [Yandex Calendar CalDAV sync](https://yandex.com/support/yandex-360/customers/calendar/web/en/sync/sync-desktop)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
