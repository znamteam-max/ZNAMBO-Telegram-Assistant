# История проекта ZNAMBO Telegram Assistant

Обновлено: 2026-06-09, Europe/Moscow.

Этот файл фиксирует историю создания и текущего состояния проекта без значений секретов. Все токены, пароли, ключи API и строки подключения намеренно не записаны.

## 1. Исходная задача

Проект был запрошен как рабочий MVP по файлу `CODEX_TASK_PERSONAL_TELEGRAM_ASSISTANT.md`.

Цель: приватный Telegram-ассистент для одного владельца, который принимает текст, голос и медиа, извлекает из сообщений задачи, встречи, напоминания, заметки и подготовку, показывает карточку подтверждения, сохраняет данные только после подтверждения, умеет напоминать и синхронизировать события с календарем.

Дополнительные требования по ходу работы:

- Подготовить проект в GitHub.
- Развернуть проект на Vercel.
- Подключить Neon Postgres.
- Настроить Telegram webhook.
- Настроить OpenAI-интеграцию.
- Поддержать календарь.
- Вместо Google Calendar использовать Yandex Calendar, если возможно.
- Создать тесты и README.
- Не останавливаться на плане, а довести до рабочего MVP.

## 2. Репозитории и окружения

GitHub:

- `https://github.com/znamteam-max/ZNAMBO-Telegram-Assistant`
- Основная ветка: `main`
- Локальная рабочая папка: `C:\Users\znambo\Documents\Личное`

Vercel:

- Team/scope: `znambos-projects`
- Project: `znambo-telegram-assistant`
- Production URL: `https://znambo-telegram-assistant.vercel.app`
- GitHub repository подключен к Vercel project.

Последний известный production deployment:

- Deployment id: `dpl_HPcyedsVstcmVAwoahrcSwTKuB1d`
- Production alias: `https://znambo-telegram-assistant.vercel.app`

## 3. Основная архитектура MVP

Приложение собрано как Next.js App Router API-проект для Vercel.

Основные части:

- Telegram webhook: `src/app/api/telegram/webhook/route.ts`
- Reminder runner: `src/app/api/reminders/run/route.ts`
- Health endpoint: `src/app/api/health/route.ts`
- Export endpoint: `src/app/api/export/route.ts`
- Google OAuth endpoints оставлены как опциональная интеграция.
- Telegram bot на `grammy`.
- OpenAI SDK для анализа сообщений и транскрибации.
- Drizzle ORM + Postgres.
- Yandex Calendar через CalDAV.
- Cloudflare Worker для минутного cron напоминаний.
- Vitest tests.
- GitHub Actions CI.

Высокоуровневый поток:

```text
Telegram
  -> /api/telegram/webhook
  -> grammY middleware
  -> allowlist owner check
  -> idempotency by Telegram update_id
  -> command/message/callback handlers
  -> OpenAI parsing/transcription
  -> pending action confirmation
  -> Postgres records
  -> optional calendar sync

Reminder cron
  -> /api/reminders/run
  -> claim due reminders
  -> Telegram notification
```

## 4. Что было реализовано

### Telegram bot

Реализованы команды:

- `/start`
- `/help`
- `/today`
- `/tomorrow`
- `/week`
- `/tasks`
- `/settings`
- `/calendar`
- `/export`
- `/forget`

Реализован allowlist владельца через `ALLOWED_TELEGRAM_USER_IDS`.

Реализован confirmation-before-write:

- бот сначала предлагает карточку действия;
- запись создается только после inline-кнопки подтверждения;
- повторный клик защищен от дублей.

Поддержаны текстовые сообщения и медиа:

- text;
- voice;
- audio;
- video note;
- короткие video/mp4 в рамках лимитов Telegram/OpenAI.

### OpenAI

Реализовано:

- структурное извлечение задач, встреч, напоминаний, памяти и неоднозначных запросов;
- fallback-ответы;
- транскрибация аудио/видео;
- модели вынесены в env:
  - `OPENAI_TEXT_MODEL`;
  - `OPENAI_TRANSCRIPTION_MODEL`.

### База данных

Используется Postgres через Drizzle.

Бизнес-таблицы размещены в отдельной схеме `assistant`, чтобы не конфликтовать с существующими таблицами в `public`.

Созданные таблицы:

- `assistant.users`
- `assistant.telegram_messages`
- `assistant.message_attachments`
- `assistant.pending_actions`
- `assistant.planner_items`
- `assistant.reminders`
- `assistant.memories`
- `assistant.google_calendar_connections`
- `assistant.item_sync_state`
- `assistant.audit_log`

Важная деталь: в предоставленной Neon DB уже были таблицы в `public`, включая `public.users`. Поэтому схема была изолирована в `assistant`, а существующие `public.*` таблицы не трогались.

Миграция была применена вручную statement-by-statement, потому что `drizzle-kit migrate` на Neon pooler соединении зависал/падал. Сама схема применена успешно. Возможная техническая оговорка: запись в Drizzle migration journal могла не сохраниться из-за `ECONNRESET` на metadata insert/select. Приложение не запускает миграции на runtime, поэтому production работе это не мешает.

### Calendar

Сначала была реализована Google Calendar-интеграция через OAuth как опциональная.

Затем по запросу пользователя добавлен Yandex Calendar через CalDAV:

- `CALENDAR_PROVIDER=yandex`
- `YANDEX_CALDAV_URL`
- `YANDEX_CALDAV_USERNAME`
- `YANDEX_CALDAV_APP_PASSWORD`
- `YANDEX_CALDAV_CALENDAR_URL` опционально
- `YANDEX_CALENDAR_URL` для пользовательской ссылки в Telegram

Health endpoint показывает:

- `calendarProvider: "yandex"`
- `yandexCalendarConfigured: true`
- `googleCalendarConfigured: false`

Текущий известный статус Yandex Calendar: bot работает, но свежие runtime logs показывали `Yandex CalDAV PROPFIND failed: 401`. Это означает, что CalDAV авторизация не проходит. На ответы бота это не должно влиять; влияет только на синхронизацию событий в Яндекс.Календарь.

### Напоминания

Реализован endpoint:

- `POST /api/reminders/run`

Он защищен `Authorization: Bearer <CRON_SECRET>`, атомарно забирает due reminders и отправляет Telegram notification.

Для минутных напоминаний подготовлен Cloudflare Worker:

- `cloudflare-reminder-worker/`

Причина: Vercel team сейчас на тарифе Hobby, а минутный Vercel Cron доступен только на Pro. Поэтому для точных минутных напоминаний нужен Cloudflare Worker или апгрейд Vercel до Pro.

### Vercel

Настроены Production и Development env vars в Vercel.

Preview env vars не были автоматически скопированы, потому что Vercel хранит Production/Preview secrets как write-only и не возвращает значения через `vercel env pull`.

Production deploy работает.

### Telegram webhook

Webhook установлен на:

```text
https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
```

Используется Telegram secret token header:

```text
x-telegram-bot-api-secret-token
```

## 5. Инциденты и исправления

### Проблема 1: конфликт таблиц в Neon

Симптом:

- миграция в `public` конфликтовала с существующими таблицами.

Решение:

- бизнес-таблицы перенесены в schema `assistant`;
- добавлено `CREATE SCHEMA IF NOT EXISTS "assistant";`;
- существующие `public.*` таблицы не изменялись.

Коммит:

- `69251fd Isolate assistant tables in Postgres schema`

### Проблема 2: SSL для Neon

Симптом:

- соединение с Neon требовало SSL.

Решение:

- DB client и Drizzle config обновлены для `ssl: "require"` при `sslmode=require`.

Коммит:

- `b9c1e80 Require SSL for Neon Postgres connections`

### Проблема 3: Telegram bot не реагировал

Симптом:

- пользователь написал, что бот не реагирует;
- `getWebhookInfo` показывал `pending_update_count` и `500 Internal Server Error`;
- Vercel runtime logs показали:

```text
Bot not initialized! Either call `await bot.init()`, or directly set the `botInfo` option in the `Bot` constructor to specify a known bot info object.
```

Причина:

- grammY bot в serverless runtime не был инициализирован перед `handleUpdate`.

Решение:

- добавлен `getInitializedBot()` с кешированием `bot.init()`;
- webhook route теперь вызывает initialized bot перед `handleUpdate`.

После деплоя:

- Telegram доставил накопленные updates;
- `pending_update_count` стал `0`;
- свежий webhook request вернул `200`;
- новых `Telegram webhook failed` / `Bot update failed` не было.

Коммит:

- `bd5f62c Initialize Telegram bot before handling webhook`

## 6. Проверки

Локально проходили:

```bash
npm test
npm run lint
npm run build
```

Последнее известное состояние:

- 9 test files passed;
- 11 tests passed;
- lint passed;
- production build passed;
- Vercel production build passed.

Health endpoint:

```text
https://znambo-telegram-assistant.vercel.app/api/health
```

Возвращал:

```json
{
  "ok": true,
  "appUrl": "https://znambo-telegram-assistant.vercel.app",
  "defaultTimezone": "Europe/Moscow",
  "calendarProvider": "yandex",
  "googleCalendarConfigured": false,
  "yandexCalendarConfigured": true
}
```

## 7. Git history

```text
bd5f62c  2026-05-27T16:06:10+03:00  Initialize Telegram bot before handling webhook
acbb7bd  2026-05-27T15:16:29+03:00  Expose Yandex calendar health status
d6d39b0  2026-05-27T14:59:39+03:00  Polish calendar commands for Yandex provider
69251fd  2026-05-27T14:39:51+03:00  Isolate assistant tables in Postgres schema
b9c1e80  2026-05-27T14:14:04+03:00  Require SSL for Neon Postgres connections
fef5965  2026-05-27T14:06:48+03:00  Add Yandex Calendar CalDAV sync
bed0844  2026-05-27T09:11:23+03:00  Add GitHub CI for deployment readiness
ca649a1  2026-05-27T09:10:11+03:00  Build personal Telegram assistant MVP
```

## 8. Переменные окружения

Ниже только имена переменных. Значения секретов в этот файл не включены.

Основные:

- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_WEBHOOK_SECRET`
- `ALLOWED_TELEGRAM_USER_IDS`
- `OPENAI_API_KEY`
- `OPENAI_TEXT_MODEL`
- `OPENAI_TRANSCRIPTION_MODEL`
- `CRON_SECRET`
- `APP_ENCRYPTION_KEY`
- `NEXT_PUBLIC_APP_URL`
- `DEFAULT_TIMEZONE`

Yandex Calendar:

- `CALENDAR_PROVIDER`
- `YANDEX_CALDAV_URL`
- `YANDEX_CALDAV_USERNAME`
- `YANDEX_CALDAV_APP_PASSWORD`
- `YANDEX_CALDAV_CALENDAR_URL`
- `YANDEX_CALENDAR_URL`

Google Calendar, если понадобится:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_CALENDAR_ID`
- `GOOGLE_TOKEN_ENCRYPTION_KEY`

## 9. Текущее состояние проекта

Работает:

- production app на Vercel;
- Telegram webhook;
- обработка Telegram updates после фикса grammY init;
- health endpoint;
- Postgres schema `assistant`;
- OpenAI parsing/transcription code path;
- confirmation-before-write flow;
- reminders data model and runner endpoint;
- Yandex Calendar provider selection.

Требует внешнего действия или проверки:

- Проверить бота руками в Telegram через `/start` и тестовое сообщение.
- Исправить Yandex CalDAV `401`, если нужна синхронизация в календарь.
- Подключить Cloudflare Worker для минутных напоминаний или перейти на Vercel Pro и включить Vercel Cron.
- При необходимости добавить Preview env vars вручную в Vercel dashboard.

## 10. Рекомендованный следующий порядок действий

1. Отправить боту `/start`.
2. Отправить тест: `завтра в 10:00 напомни позвонить`.
3. Нажать кнопку подтверждения в карточке.
4. Проверить, что запись появилась в `/tomorrow` или `/tasks`.
5. Если нужна календарная синхронизация, проверить Yandex app password и CalDAV endpoint.
6. Подключить Cloudflare Worker для minute cron.
7. После этого протестировать реальное напоминание на ближайшие 2-3 минуты.

## 11. Обновление 2026-06-01: V2 Smart AI Planner

Пользователь передал новый файл задачи:

- `CODEX_TASK_ZNAMBO_ASSISTANT_V2_SMART_AI_PLANNER (1).md`

Цель V2: перестроить проект из одношагового механического парсера в smart AI planner.

Реализовано в рабочем дереве:

- Добавлен multi-action `ActionPlan` вместо единственного `pending_action`.
- Добавлены схемы и миграция для:
  - `action_plans`;
  - `action_plan_items`;
  - `conversation_messages`;
  - `memory_facts`;
  - `conversation_summaries`;
  - `reminder_deliveries`;
  - `calendar_sync_jobs`;
  - новых полей recurring / repeat-until-ack в `reminders`;
  - `smart_commit_mode` в `users`.
- Добавлен smart planner:
  - `src/ai/planner.ts`;
  - `src/ai/heuristicActionPlanner.ts`;
  - `src/ai/plan-validator.ts`;
  - `src/ai/prompts/planner.system.ts`.
- Перед каждым ответом добавлен retrieval context:
  - memory facts;
  - conversation summaries;
  - recent messages;
  - active tasks;
  - items for the next 7 days.
- Telegram message flow переключен на:
  - save incoming conversation;
  - transcribe if needed;
  - build active context;
  - build `ActionPlan`;
  - smart commit or confirmation;
  - one multi-action summary instead of several duplicate cards.
- Добавлены recurring reminders и repeat-until-ack:
  - кнопки ack/snooze/skip/stop;
  - повтор, если нет подтверждения;
  - запись доставок в `reminder_deliveries`.
- Добавлена команда:
  - `/remindertest 2`
- Calendar sync оставлен best-effort:
  - DB и Telegram reminders являются source of truth;
  - calendar failure не блокирует сохранение;
  - шумные сообщения про ошибку календаря убраны из нового V2 flow.
- Обновлены:
  - `.env.example`;
  - `README.md`;
  - tests setup.

Добавлены acceptance tests по реальным кейсам из V2-файла:

- today basketball call;
- long Zoom + setup + tentative call + training;
- recurring reels reminder;
- NBA night event at `03:30`, not `15:30`;
- daily vitamins until ack.

Проверки после реализации:

```text
npm test      -> 10 files passed, 16 tests passed
npm run lint  -> passed
npm run build -> passed
```

Осталось применить перед production-проверкой:

- применить миграцию `drizzle/0001_smart_planner_v2.sql` к production DB;
- задеплоить обновленный код;
- проверить `/remindertest 2` в Telegram;
- убедиться, что Cloudflare Worker или другой cron реально вызывает `/api/reminders/run` каждую минуту.

## 12. Правило ведения истории

С 2026-06-01 пользователь попросил: после каждого сообщения вести файл с историей и изменениями.

Принято правило:

- после каждого значимого изменения проекта обновлять `PROJECT_HISTORY.md`;
- не записывать секреты, токены, пароли, ключи API и строки подключения;
- фиксировать, что изменено, какие проверки пройдены, что осталось сделать;
- если изменений в коде нет, фиксировать только важные решения или инструкции пользователя.

## 13. Rollout 2026-06-01: старт production-доводки V2

Пользователь попросил продолжить по актуальному `PROJECT_HISTORY.md` и довести уже реализованный V2 до production.

План rollout без переписывания V2:

1. Применить `drizzle/0001_smart_planner_v2.sql` к production Neon DB.
2. Проверить новые таблицы и поля в schema `assistant`.
3. Закоммитить и запушить V2-код.
4. Задеплоить Vercel production.
5. Проверить `/api/health`.
6. Проверить Telegram webhook после деплоя.
7. Проверить `/remindertest 2` или эквивалентную доставку реального reminder через runner.
8. Проверить, есть ли активный minute cron; если нет, дать точные Cloudflare команды.

Статус на момент старта:

- рабочее дерево содержит V2-изменения;
- `PROJECT_HISTORY.md` пока не был закоммичен;
- секреты в историю не записываются.

### 13.1. Production DB migration

Миграция `drizzle/0001_smart_planner_v2.sql` применена к production Neon DB.

Проверка schema `assistant` после применения:

- всего таблиц в `assistant`: 17;
- новые таблицы присутствуют:
  - `action_plans`;
  - `action_plan_items`;
  - `conversation_messages`;
  - `conversation_summaries`;
  - `memory_facts`;
  - `reminder_deliveries`;
  - `calendar_sync_jobs`;
- новые поля в `users`:
  - `smart_commit_mode`;
- новые поля в `reminders`:
  - `repeat_until_ack`;
  - `acked_at`;
  - `parent_reminder_id`;
  - `recurrence_key`.

PostgreSQL выдал только NOTICE о сокращении длинного имени foreign key constraint. Ошибок миграции не было.

### 13.2. Pre-deploy checks

После применения production DB migration повторно прогнаны проверки на текущем V2-коде:

```text
npm test      -> 10 files passed, 16 tests passed
npm run lint  -> passed
npm run build -> passed
```

### 13.3. GitHub push and Vercel deploy blocker

V2 rollout закоммичен и отправлен в GitHub:

```text
2ac48aa Roll out smart planner V2
```

`main` синхронизирован с `origin/main`.

Блокер прямого Vercel deploy из CLI:

- локальный `.vercel/project.json` указывает на production project `znambo-telegram-assistant`;
- текущая авторизация Vercel CLI больше не видит прежний scope `znambos-projects`;
- `npx vercel --prod --yes --scope znambos-projects` вернул ошибку `scope does not exist`;
- `npx vercel whoami` вернул `Not authorized`;
- `npx vercel teams ls` показал доступ только к `bolshes-projects`;
- вызов deploy без scope не смог прочитать settings linked project.

Health production URL при этом отвечает:

```text
https://znambo-telegram-assistant.vercel.app/api/health -> ok
```

Для завершения rollout нужен доступ Vercel CLI к team/project, где живет `znambo-telegram-assistant`, или подтверждение, что GitHub auto-deploy в этом проекте сработал после push `2ac48aa`.
### 13.4. Vercel auth wait

Rollout resumed from `PROJECT_HISTORY.md`. Production DB migration is already applied and V2 code is pushed to GitHub commit `2ac48aa`.

Current blocker remains Vercel authorization: `vercel login` is still waiting for device-flow confirmation, so direct production deploy and deployment inspection cannot proceed yet. No secrets were written to this history file.

### 13.5. Fresh Vercel auth request

The stale Vercel login session was cancelled and a fresh `vercel login` device-flow session was started.

Current auth URL:

```text
https://vercel.com/oauth/device?user_code=SPBW-ZXPB
```

Direct production deploy is paused until this device-flow authorization is approved for the Vercel account/team that owns `znambo-telegram-assistant`.

### 13.6. Health and cron code inspection

Production health endpoint currently responds successfully:

```text
GET https://znambo-telegram-assistant.vercel.app/api/health -> ok
calendarProvider -> yandex
yandexCalendarConfigured -> true
```

This proves the production URL is alive, but not yet that commit `2ac48aa` is the active deployment because the health payload does not expose a commit/version field.

Reminder cron code is present in `cloudflare-reminder-worker`:

- `wrangler.toml.example` contains `crons = ["* * * * *"]`;
- worker calls `POST /api/reminders/run`;
- worker authenticates with `Authorization: Bearer <CRON_SECRET>`.

Real Cloudflare Worker deployment and real scheduled invocations are not yet confirmed.

### 13.7. Telegram webhook check

Telegram Bot API `getWebhookInfo` was checked against the configured bot.

Safe result fields:

```text
url -> https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
pending_update_count -> 0
last_error_message -> null
allowed_updates -> message, callback_query
```

The webhook is pointed at the production Vercel endpoint and Telegram reports no current delivery error.

This check should be repeated after the final confirmed Vercel production deployment.

### 13.8. Cloudflare cron status

Wrangler is authenticated locally for `znamteam@gmail.com`.

Cloudflare API check for worker `personal-assistant-reminder-worker` returned:

```text
Worker does not exist on your account.
```

So the minute cron is not currently connected under the expected worker name. The repository contains a worker template, but no real `wrangler.toml` file yet.

### 13.9. Cloudflare worker deploy config

Added `cloudflare-reminder-worker/wrangler.toml` without secrets:

```text
name -> personal-assistant-reminder-worker
main -> src/index.ts
cron -> * * * * *
```

`npx wrangler deploy --dry-run` succeeds:

```text
Total Upload: 0.94 KiB / gzip: 0.51 KiB
No bindings found.
```

The worker can now be deployed, but real cron delivery still requires setting `APP_REMINDER_RUN_URL` and `CRON_SECRET` and confirming that Vercel production uses the same `CRON_SECRET`.

### 13.10. Reminder runner production SQL fix

During rollout verification, the reminder runner path was inspected and a production bug was found:

```text
claimDueReminders used raw SQL table name `reminders`
```

Production tables are in schema `assistant`, so the raw SQL was fixed to use:

```text
"assistant"."reminders"
```

Verification after the fix:

```text
npm test -> 10 files passed, 16 tests passed
npm run lint -> passed
npm run build -> passed
```

### 13.11. Health deployment commit marker

Direct Vercel CLI deploy remains blocked by the linked `.vercel` project belonging to an inaccessible Vercel scope. To make GitHub auto-deploy verifiable from the public production URL, `/api/health` now includes a safe `deploymentCommit` field from `VERCEL_GIT_COMMIT_SHA`.

### 13.12. Production deployment confirmed

Commit `5c776ae` was pushed to GitHub:

```text
5c776ae Finalize production rollout plumbing
```

Production Vercel auto-deploy completed successfully. Public health now returns:

```text
ok -> true
deploymentCommit -> 5c776ae5801e2a7d7b51b0f4248c4c6c5b90bf9a
appUrl -> https://znambo-telegram-assistant.vercel.app
defaultTimezone -> Europe/Moscow
calendarProvider -> yandex
yandexCalendarConfigured -> true
```

Telegram webhook was checked again after deploy:

```text
url -> https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
pending_update_count -> 0
last_error_message -> null
allowed_updates -> message, callback_query
```

### 13.13. Reminder cron blocker

Production `POST /api/reminders/run` returns `401 unauthorized` without a bearer token. This confirms that the endpoint is deployed and protected by `CRON_SECRET`.

Cloudflare Worker is still not deployed:

```text
personal-assistant-reminder-worker -> does not exist on Cloudflare account
```

Current blocker: the existing Vercel production project is in an inaccessible Vercel scope, so the current `CRON_SECRET` value cannot be read or changed from CLI. To connect Cloudflare cron safely, Cloudflare must receive the exact same `CRON_SECRET` value as Vercel production, or Vercel access must be granted to the project scope so the secret can be rotated in both places.

### 13.14. Latest production commit after history push

The final history-only commit was pushed and Vercel auto-deployed it as well:

```text
56299a5 Record production deploy verification
```

Production health now returns:

```text
deploymentCommit -> 56299a57713c267afca706101a6aa2dd491f7611
ok -> true
```

Telegram webhook after this deploy still reports:

```text
pending_update_count -> 0
last_error_message -> null
```

### 13.15. Cron secret and runner verification

The provided `CRON_SECRET` was tested against production `POST /api/reminders/run`.

Result:

```text
without bearer -> 401 unauthorized
with provided bearer -> not 401, but runner returned 500
```

The `500` was reproduced locally against production DB. Root cause:

```text
postgres-js raw SQL parameter binding rejected Date objects in claimDueReminders
```

Fix applied:

```text
claimDueReminders now passes now.toISOString() and casts it as timestamptz
```

Local runner verification after the fix:

```text
claimed -> 2
sent -> 2
failed -> 0
```

This proves the reminder delivery path can send Telegram messages once the fixed code is deployed.

### 13.16. Cloudflare worker created, cron limit blocker

The fixed runner was pushed as commit:

```text
55b62f6 Fix reminder cron timestamp binding
```

Vercel production health confirmed:

```text
deploymentCommit -> 55b62f6ef85e9c85c054eca5c1a40de8c7f05eb4
```

Production runner check with the provided bearer secret:

```text
POST /api/reminders/run -> ok: true, claimed: 0, sent: 0, failed: 0
```

Cloudflare worker status:

```text
worker -> personal-assistant-reminder-worker
url -> https://personal-assistant-reminder-worker.znamteam-903.workers.dev
manual fetch -> ok: true, claimed: 0, sent: 0, failed: 0
secrets -> APP_REMINDER_RUN_URL, CRON_SECRET
schedules -> none
```

Cloudflare scheduled trigger could not be attached because the account already has the plan limit of 5 cron triggers.

Existing Cloudflare cron triggers:

```text
anfisa-training-stats      -> */15 * * * *
hoh-nhl-daily-results      -> */5 * * * *
mlb-daily-results          -> * * * * *
nba-players-proxy          -> */15 * * * *
tennis-daily-results       -> */15 * * * *
```

To finish automatic minute reminders, one existing Cloudflare cron trigger must be removed or the Cloudflare plan/limit must be increased. The new worker itself is ready and verified manually.

### 13.17. cron-job.org production scheduler

Cloudflare cron is no longer a production blocker.

Current production scheduler:

```text
provider -> cron-job.org
method -> POST
url -> https://znambo-telegram-assistant.vercel.app/api/reminders/run
test run -> 200 OK
```

Telegram delivery was confirmed through the real bot command:

```text
/remindertest 2 -> created a real reminder
real Telegram reminder -> delivered after about 2 minutes
```

Conclusion:

- automatic reminder delivery is confirmed in production;
- `/api/reminders/run` delivers real Telegram reminders;
- cron-job.org is the active production scheduler;
- Cloudflare Worker remains configured as a backup option, but it no longer blocks production rollout.

### 13.18. Smart planner production behavior fixes

The V2 Telegram flow was reviewed against the required production behavior scenarios.

Code fixes applied:

```text
history/retrieval -> memory retrieval now falls back to latest active facts when exact keyword search finds nothing
memory learning -> memory-only messages such as "Запомни: ..." are stored as memory facts without creating pending actions
action planner -> NBA/night sports rules can be saved as correction memory candidates
action planner -> "ночь на пятницу" resolves to Friday 03:30 local time, not 15:30
multi-action -> Zoom/preparation/tentative call/training scenario keeps separate actions instead of collapsing into one meeting
recurring reminders -> repeat-until-ack reminders continue chaining until acknowledgement or local cutoff
overview commands -> list queries now use typed Drizzle predicates for reliable date filtering
reminder keyboard -> repeat-until-ack reminders expose completion, snooze, skip, and stop actions
```

Validation completed locally and rerun before production deploy:

```text
npm test -> passed, 21 tests
npm run lint -> passed
npm run build -> passed
```

New tests cover:

```text
multi-action extraction from one real message
recurring reminder buttons and repeat-until-ack behavior
night sports event at 03:30 Moscow in "ночь на пятницу"
memory-only correction rule creation
repeat-until-ack runner chaining
```

### 13.19. Production smart planner verification

The smart planner fixes were committed and pushed to GitHub:

```text
commit -> 767f6cb3a63a9d98a0346a8ab1ae285bd739c663
message -> Verify smart planner production behavior
branch -> main
```

Vercel production auto-deploy completed. Health endpoint confirmed:

```text
url -> https://znambo-telegram-assistant.vercel.app/api/health
ok -> true
deploymentCommit -> 767f6cb3a63a9d98a0346a8ab1ae285bd739c663
calendarProvider -> yandex
yandexCalendarConfigured -> true
```

Telegram webhook check after deploy:

```text
webhook url -> https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
pending_update_count -> 0
last_error_message -> null
allowed_updates -> message, callback_query
```

Protected reminder runner check after deploy:

```text
POST /api/reminders/run -> ok: true
claimed -> 0
sent -> 0
failed -> 0
```

Fresh `/remindertest 2` verification:

```text
created reminder -> 8523e175-3a05-4332-9ea0-c77c4d03c763
scheduledAt -> 2026-06-01T14:33:14.685Z
sentAt -> 2026-06-01T14:34:04.350Z
deliveryStatus -> sent
deliveredAt -> 2026-06-01T14:34:04.537Z
telegramMessageId -> 39
```

This confirms cron-job.org is calling the production runner and real Telegram delivery still works after the smart planner deploy.

Real multi-action Telegram-flow scenario A was run against production DB through the bot handler. Result:

```text
actionPlan -> 9613ee65-7e74-4174-ab1d-58e53daeec85
status -> committed
summary -> Разложил сообщение на запись, подготовку, tentative-созвон и тренировку.
confidence -> 92
items -> 4
```

Created action plan items:

```text
0 preparation      -> Начать настройку Zoom, due 2026-06-01T18:30:00, reminders 1
1 event            -> Запись Больше Zoom, start 2026-06-01T19:00:00, reminders 3
2 tentative_event  -> Возможный созвон по коротким видео, start 2026-06-01T19:30:00, reminders 1
3 training         -> Велосипед Z2, start 2026-06-01T20:00:00, reminders 2
```

Conclusion for scenario A:

- one V2 ActionPlan was created;
- actions were not collapsed into one meeting;
- preparation, event, tentative call, and training were stored separately;
- duplicate card behavior was not observed.

Overview command behavior was checked after creating the multi-action scenario:

```text
/today -> handler accepted; schedule query returned preparation, event, tentative_event, training, and reminder-test tasks
/tomorrow -> handler accepted; no items for the next day at verification time
/week -> handler accepted; weekly query returned the same structured items
/tasks -> handler accepted; open tasks included preparation and the recurring reels reminder
```

Production scheduler status:

```text
active scheduler -> cron-job.org
Cloudflare Worker -> backup only
production blocker -> none
```

Operational notes:

- the production webhook requires Telegram secret-token header, so synthetic webhook POSTs were not used;
- production behavior was verified through Bot API webhook metadata, the deployed health endpoint, the protected runner endpoint, production DB state, and bot handler checks using the same deployed commit;
- one malformed synthetic local update caused by PowerShell pipe encoding was cancelled immediately and was not used for verification;
- calendar sync remains best-effort by design, so DB commit and Telegram reminders are not blocked by calendar sync failures.

### 13.20. Intent-first assistant hardening started

New production-hardening task accepted.

Goal:

```text
make the bot behave as an adaptive daily assistant, not as a mechanical parser that creates items from every phrase
```

Scope for this pass:

```text
intent-first message pipeline
anti-garbage validation before saving items
task management view for edit/show task requests
ordered list parsing into separate floating tasks/calls
training report plus tentative training plan handling
tentative follow-up wording and actions
debug trace for the latest decision
tests for the real failure cases
```

Existing production pieces must remain intact:

```text
Telegram webhook
Postgres assistant schema
OpenAI transcription
reminders runner
cron-job.org delivery
/remindertest
V2 tables
Yandex calendar best-effort sync
```

### 13.21. Intent-first assistant implementation

Implemented without a new database migration. Existing `assistant.audit_log` is used for decision traces, and existing `planner_items.metadata` is used for list order, floating items, tentative flags, and training state.

Changed behavior:

```text
task-management phrases -> no new planner items; bot shows current tasks for editing
status questions -> schedule/status response instead of task creation
ordered bullet lists -> separate floating tasks/calls with preserved order
training missed reports -> saved as note/training report, not task title
tomorrow Holmy long ride -> tentative training plan with no arbitrary exact ride time
memory/correction phrases -> memory update, no item creation
AI planner fallback -> protected by anti-garbage validator before saving
active context retrieval -> best-effort; transient DB errors do not block message handling
tentative event follow-up -> asks whether the event happened or was cancelled
/tasks -> editable task-management view
/debuglast -> shows latest decision trace without secrets
```

Files added:

```text
src/ai/schemas/assistantDecision.ts
src/ai/assistantDecision.ts
src/ai/antiGarbageValidator.ts
src/services/assistantPlanBuilders.ts
src/bot/messagePipeline.ts
src/tests/assistantDecision.test.ts
```

Files updated:

```text
src/ai/schemas.ts
src/ai/heuristicActionPlanner.ts
src/ai/prompts/planner.system.ts
src/bot/commands.ts
src/bot/messageHandlers.ts
src/bot/messagePipeline.ts
src/bot/callbacks.ts
src/bot/formatters.ts
src/bot/keyboards.ts
src/db/queries/audit.ts
src/db/queries/items.ts
src/jobs/runDueReminders.ts
src/services/actionPlanCommit.ts
src/services/contextRetrieval.ts
```

Validation completed locally:

```text
npm test -> passed, 32 tests
npm run lint -> passed
npm run build -> passed
```

Additional production-hardening fix:

```text
active context retrieval can hit transient Neon connection errors
message pipeline now logs the context error, stores it in decision trace, and continues without blocking the user's request
```

New tests cover:

```text
edit task request creates zero new tasks
ordered task list becomes six separate items
training missed plus tentative Holmy ride does not become one task title
anti-garbage validator blocks command text as item title
tentative follow-up asks whether it happened or was cancelled
tentative training plan appears in day views
memory correction is classified as memory_update
command-like texts do not create tasks
```

### 13.22. Production deploy for intent-first assistant

Code was pushed to GitHub:

```text
commit -> 48f934e76d5e53e93637d8cd5cb1ef36ad3f1760
message -> Add intent-first assistant pipeline
```

Additional resilience fix was pushed:

```text
commit -> 4e027c4648678a4e6999bc0b566f66ace066d85c
message -> Make context retrieval best effort
```

Vercel production health confirmed:

```text
url -> https://znambo-telegram-assistant.vercel.app/api/health
ok -> true
deploymentCommit -> 4e027c4648678a4e6999bc0b566f66ace066d85c
calendarProvider -> yandex
yandexCalendarConfigured -> true
```

Telegram webhook check:

```text
webhook url -> https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
pending_update_count -> 0
last_error_message -> null
```

Reminder runner check:

```text
POST /api/reminders/run -> ok: true
claimed -> 0
sent -> 0
failed -> 0
```

Local production DB synthetic verification status:

```text
direct local TCP queries to Neon intermittently returned read ECONNRESET
active context retrieval was made best-effort so this kind of transient context failure does not block message handling
fresh reminder creation from local scripts was not completed because inserts also hit ECONNRESET
```

Pending final manual verification:

```text
send /remindertest 2 in Telegram after this deploy
confirm the Telegram reminder arrives
record the result in PROJECT_HISTORY.md
```

### 13.23. Chat/version history file requirement

New operating rule from the user:

```text
after each message, maintain a file with chat history and version updates
```

Implementation:

```text
CHAT_HISTORY.md created at the project root
PROJECT_HISTORY.md remains the production rollout/history file
CHAT_HISTORY.md is now the turn-by-turn continuity log
```

Safety:

```text
do not write secrets, tokens, passwords, API keys, bearer tokens, database URLs, or private credentials into either history file
```

Attached context received in the same turn:

```text
a large Jarvis Mode specification for the next architecture step was attached
implementation of that specification has not started in this turn
```

### 13.24. Jarvis Mode MVP implementation

User request:

```text
implement the attached Jarvis Mode / agentic assistant specification without rewriting V2 from scratch
```

Implemented locally:

```text
added Jarvis Mode feature flag JARVIS_MODE_ENABLED, default true
added central src/agent/jarvisPipeline.ts
added deterministic Jarvis decision layer for plan views, task views, yesterday review, evening review, delete-by-index, done-by-index, cleanup, and undo
delegates real task/event/training/multi-action creation to the existing V2 smart planner
added rich context builder that includes active retrieval and latest task view state
added task view state storage so numbered lists can be managed later by messages like "delete 7-12 and 14"
added agent action history for debug/undo
added cleanup validator for debug/test/command-like garbage items
updated Telegram natural text and voice transcript flow to enter Jarvis Mode before V2 fallback
updated /today, /tomorrow, /week, /tasks to render through Jarvis tools and save task view state
added /review_yesterday, /cleanup_garbage, and /undo commands
updated inline done/delete/tentative callbacks to cancel future reminders for affected items
updated morning digest to include overdue open items so it does not look empty when yesterday has unfinished work
made Jarvis task-view retrieval, task-view save, and agent-action save best-effort so rollout does not break Telegram flow if migration 0002 is applied slightly later
```

Database changes:

```text
new migration drizzle/0002_jarvis_mode.sql
new assistant.task_view_states table
new assistant.agent_actions table
drizzle journal updated with 0002_jarvis_mode
```

New tests:

```text
Jarvis full-plan requests create zero tasks
delete ranges like 7-12 and 14 route to task-view tools
yesterday review creates zero tasks
real multi-action capture still delegates to V2 planner
task view state resolves display numbers to item ids
cleanup detects debug and command-like garbage
morning digest includes overdue open items
```

Validation completed locally:

```text
npm test -> passed, 39 tests
npm run lint -> passed
npm run build -> passed
checks were rerun after rollout-safety changes
```

Production status:

```text
deployed to Vercel production via GitHub auto-deploy
production commit -> beba0341a2800b00a4ea0f7096ed800f8f4ee4f2
0002_jarvis_mode migration applied to production Neon
assistant.task_view_states and assistant.agent_actions verified in schema assistant
health endpoint ok -> true
calendar provider -> yandex
Telegram webhook url -> https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
Telegram webhook pending_update_count -> 0
Telegram webhook last_error_message -> null
POST /api/reminders/run after deploy -> ok true, claimed 0, sent 0, failed 0
direct production reminder smoke test -> claimed 1, sent 1, failed 0
reminder_deliveries row confirmed -> status sent with Telegram message id
temporary smoke-test planner item was cancelled after delivery so it does not remain in active tasks
manual /remindertest 2 from the user's Telegram client was not run by Codex because Bot API cannot send an inbound user command
```

### 13.25. Full production repair implementation

Root causes confirmed:

```text
Jarvis management handlers could still fall through to legacy V2 after a handler error
the old pending_action confirmation path could create a management phrase
daily digests used unbounded historical open-item queries
numbered renderers and task_view_state mapping were not one atomic operation
test reminders remained active after successful delivery
```

Implemented:

```text
central hard-management detector and deterministic router
hard guard before Jarvis AI, legacy V2, pending_action writes, and ActionPlan writes
safe no-create response when a management handler fails
reset_active_plan confirmation flow with all/garbage-only/show/cancel buttons
owner-only /admin_reset_active_plan command
soft archive, reminder-chain cancellation, calendar-sync-job cancellation, agent action snapshot, and undo
strict daily/evening/yesterday-carry/recent-range/full-plan queries
single renderAndSaveTaskView helper with exact sequential 1..N mapping
task_view_state persistence for morning and evening scheduled reviews
native recent-range rendering
known production pollution and giant multiline garbage detection
/remindertest metadata plus automatic archive after delivery
/debuglast pipeline markers
/api/health Jarvis mode marker
edited-message routing through the same guarded pipeline
```

Local validation:

```text
npm test -> 18 files passed, 56 tests passed
npm run lint -> passed
npm run build -> passed
git diff --check -> passed
```

One-time production cleanup status:

```text
direct local production Neon preview was attempted
Neon pooler and direct endpoint repeatedly returned ECONNRESET
no production cleanup mutation was applied without a reliable preview
the confirmed owner-only cleanup flow is ready for deployment
```

### 13.26. Production repair rollout and data cleanup

Production commits:

```text
d7ade75 Repair Jarvis production management flow
3b0230c Add protected production repair endpoint
100a7f4 Add production reminder smoke verification
```

Deployment verification:

```text
production URL -> https://znambo-telegram-assistant.vercel.app
health ok -> true
pipelineMode -> jarvis
jarvisModeEnabled -> true
deploymentCommit -> 100a7f4a7255eecea0a29963d96bf3fa42ee3ce0
Telegram webhook pending updates -> 0
Telegram webhook last error -> none
protected reminder runner -> ok true, claimed 0, sent 0, failed 0
```

One-time targeted production cleanup:

```text
preview open items -> 21
preview targeted garbage/test items -> 14
preview test items -> 2
preview attached active reminders -> 0
archived targeted garbage/test items -> 14
remaining active items -> 7
remaining garbage items -> 0
remaining test items -> 0
remaining attached active reminders -> 0
```

The archived set included:

```text
legacy giant multiline meeting
old Zoom setup/tentative call/Z2 test scenario
old calls and content tasks listed in the production incident
the erroneous delete-command planner item
two old reminder-test planner items
```

Production reminder smoke:

```text
created a protected production reminder smoke due in 2 minutes
did not manually invoke the reminder runner while waiting
automatic scheduler delivered the reminder
reminder status -> sent
delivery status -> sent
test planner item status -> cancelled
autoArchivedAfterDelivery -> true
post-smoke garbage/test preview -> 0
```

Final validation:

```text
npm test -> 18 files passed, 56 tests passed
npm run lint -> passed
npm run build -> passed
```

Remaining operational limitation:

```text
best-effort external calendar entries are not deleted during active-plan reset; their pending sync jobs are cancelled and the assistant database remains the source of truth
```

### 13.27. Mandatory OpenAI observability and agent execution rollout

Production incident:

```text
The headed list "На сегодня" was bypassing OpenAI and was saved by the deterministic ordered-list path.
The three timed entries became generic tasks due at 23:59.
The relative instruction about every event was saved as a fourth generic task.
decideUserIntentWithAI did not call OpenAI at all.
The legacy ActionPlan builder silently used heuristic fallback after OpenAI errors.
```

Implemented:

```text
all non-command natural-language turns now use the mandatory Jarvis agent pipeline
OPENAI_REQUIRED_FOR_NATURAL_LANGUAGE defaults to true
only exact saved-view index operations remain deterministic natural-language operations
OpenAI failures are fail-closed and cannot create or update planner items
the agent uses a forced strict Responses API function tool with Zod validation
one schema-only retry is allowed; authentication, rate-limit and network failures are not hidden
the model must choose one primary execution path per turn
relative references receive real planner item IDs and latest task-view IDs in retrieval context
model-proposed item updates create before-event reminders, follow-ups and management metadata
task management keyboards now include separate edit controls
recently missed follow-ups receive an idempotent one-minute catch-up
```

Per-turn audit telemetry stored in `assistant.audit_log`:

```text
pipelineUsed
preRouterIntent
aiRequired
aiCalled
aiSucceeded
aiModel
openaiResponseId
requestStartedAt
requestFinishedAt
latencyMs
inputTokens
outputTokens
totalTokens
structuredOutputValid
toolCallsProposed
toolCallsExecuted
fallbackUsed
fallbackReason
validationWarnings
finalAction
createdItemIds
updatedItemIds
errorCode
safeErrorMessage
```

Operational diagnostics:

```text
/aihealth performs a real minimal Responses API request with a harmless strict tool
/debuglast renders the latest mandatory AI trace
/api/health exposes only safe OpenAI status fields
the protected production probe can verify model proposals without mutating user data
the protected confirmed execution probe verifies model proposal -> validation -> DB tool execution
```

Production proof on behavioral commit `4fb97b3528b0eb9793b79b23f36538548a578ba9`:

```text
health ok -> true
openAiConfigured -> true
openAiRequiredForNaturalLanguage -> true
lastAiModel -> gpt-4o-mini-2024-07-18
lastAiErrorType -> null
Telegram webhook pending updates -> 0
Telegram webhook last error -> none
reminder runner -> ok
```

Real OpenAI health call:

```text
aiCalled -> true
aiSucceeded -> true
structuredOutputValid -> true
toolCallsProposed -> report_ai_health
model -> gpt-4o-mini-2024-07-18
a safe OpenAI response ID and token usage were returned and audited
no planner items were created
```

Exact production list execution:

```text
input -> headed three-item "На сегодня" list from the incident
toolCallsProposed -> create_action_plan
toolCallsExecuted -> create_action_plan
fallbackUsed -> false
created items -> 3
kinds -> event, event, training
titles -> Красочный забег, Эфир ВС, Тренировка Z2
local start times -> 10:00, 13:00, 22:00
dueAt -> null for all three
```

Exact production relative update execution:

```text
input -> remind one hour before every event, ask afterwards, expose separate management controls
toolCallsProposed -> update_existing_items
toolCallsExecuted -> update_existing_items
fallbackUsed -> false
updated items -> the same 3 created item IDs
managementButtonsRequested -> true for all three
future reminders/follow-ups were created
past one-hour reminders were reported as validation warnings instead of backdated
the recently missed race follow-up was scheduled as an idempotent catch-up
```

Automatic delivery proof:

```text
the model-driven catch-up reminder was not run manually
cron-job.org claimed it automatically
reminder status -> sent
delivery status -> sent
Telegram delivery timestamp was recorded
```

Production data repair:

```text
preview found exactly four records from the reported incident
three generic 23:59 tasks and the generic management-instruction task were archived
post-cleanup targeted garbage count -> 0
the corrected model-driven records were then created through the protected execution proof
```

Final validation:

```text
npm test -> 20 files passed, 64 tests passed
npm run lint -> passed
npm run build -> passed
```

Remaining limitation:

```text
the protected execution proof does not render a Telegram summary card itself
the normal webhook path uses the same proposal, validator, commit and update services and adds the user-facing summary/buttons
```

### 13.28. V2.3.0 contextual planner operations

Fresh production behavior report:

```text
a generic completion reply after a follow-up updated three items instead of completing one
a hybrid "show today + add preparation" request copied existing event/training context into new records
time-change replies did not reliably mutate start/end fields
one event update produced duplicate titles in the response
configured follow-ups did not expose the requested per-item management controls
```

Implemented:

```text
itemUpdates now use typed operations: configure, complete, reschedule
reschedule supports explicit local start and end datetime fields
multiple updates for the same item ID are merged before one DB mutation
completion cancels the completed item's future reminder chain
reschedule preserves and recalculates active reminder policies
configured follow-ups show Done, Reschedule, Edit and Delete buttons
the latest delivered follow-up is included in retrieval context
generic completion replies bind to one fresh follow-up item for 45 minutes
stale task-view snapshots are reloaded from current planner rows and filtered to active items
non-active planner IDs cannot be mutated
events are included in manageable current-item retrieval
explicit clock times in source text are checked against proposed ISO times before DB writes
hybrid create-plus-view requests support a post-execution view
ActionPlans are deduplicated against active items before commit
same-day task/preparation entries with the same title are treated as duplicates
```

Version reporting:

```text
application version -> 2.3.0
/api/health now exposes appVersion
versions/README.md defines the per-version file rule
separate summaries created for V2.0.0, V2.1.0, V2.2.0 and V2.3.0
```

Production repair and verification:

```text
two confirmed late duplicate records were archived
one preparation duplicate created by the protected hybrid verification was archived
the original records and their reminder policies were preserved
two-item reschedule executed against preparation and training IDs
event range reschedule executed against one active event ID
final local schedule -> Эфир ВС 13:00-20:00, Подготовка к ЧМ 22:00, Тренировка Z2 23:00
hybrid verification after dedup created no new items
Telegram webhook pending updates -> 0
Telegram webhook last error -> none
reminder runner -> ok
```

Validation:

```text
npm test -> 22 files passed, 75 tests passed
npm run lint -> passed
npm run build -> passed
behavioral production commit -> 29cbfa7efcd1e1b8dd47131d32f3696da6d7d01b
```

Remaining limitations:

```text
the contextual follow-up anchor expires after 45 minutes
calendar synchronization remains best-effort
```

### 13.29. V2.4.0 Live Plan Dashboard and Reminder Policy Engine

Implemented:

```text
new migration drizzle/0003_live_dashboard_reminder_policies.sql
live dashboard table and service with one active dashboard per chat
Telegram message registry with safe delete and keyboard-disable fallback
reminder policy and policy occurrence tables
policy-backed ActionPlan reminders
typed OpenAI reminderPolicies execution schema
interval-window policies that create only the next occurrence
weekly, biweekly, nag-until-ack and long-term policy support
neutral post-event reaction menus
dashboard refresh after planner mutations, callbacks and reminder delivery
/dashboard, /reminders, /longterm and /cleanup_chat
```

Regression coverage:

```text
old dashboard is retired before a new dashboard is registered
event due delivery exposes reaction actions instead of a single question
interval window creates one policy and one next reminder
interval policy advances one occurrence at a time
weekly mirror and biweekly ЖКХ rules remain long-term policies
failed Telegram deletion disables the stale card
all V2.3 regressions remain green
```

Pre-production validation:

```text
npm test -> 26 files passed, 83 tests passed
npm run lint -> passed
npm run build -> passed
```

Initial production rollout:

```text
production commit -> 96b41f088ea8aea956d0f0bbf195388027591cd4
health -> appVersion 2.4.0, live dashboard enabled, policy engine enabled
Telegram webhook -> pending 0, last error none
reminder runner -> 200 OK
all four V2.4 tables and planner/reminder V2.4 columns verified in Neon
protected agent probe extended to expose and execute reminder policy proposals
```

### 13.30. V2.4.0 final production policy verification

Production probes first proved that OpenAI was called successfully but exposed weak model
classification for interval, weekly/biweekly and every-event reminder requests.

Implemented without bypassing mandatory AI:

```text
post-AI semantic normalization after a valid OpenAI structured tool call
interval-window correction to one task plus one policy
weekly and biweekly correction to long-term recurring policies
every-event before/post correction to update_existing_items
expanded protected probe fields for due time, categories, windows and requireAck
```

Final validation:

```text
npm test -> 27 files passed, 87 tests passed
npm run lint -> passed
npm run build -> passed
verified behavioral production commit -> b90bdcfc0e2ba4fdf322a2d233ececcbeec37d24
OpenAI production health -> succeeded, structured output valid, response ID present
daily-list production probe -> event, event, training at 10:00, 13:00 and 22:00
interval production probe -> one task due 11:00 and one 08:00-11:00 policy every 30 minutes
weekly/biweekly production probe -> recurring_car weekly and recurring_finance every_2_weeks
before/post production probe -> existing active IDs updated, no generic task proposed
/api/health -> ok, appVersion 2.4.0
Telegram webhook -> pending 0, no last error
reminder runner -> 200 OK, failed 0
```

Remaining manual acceptance:

```text
visually confirm dashboard replacement and reaction-menu callback cleanup in Telegram
```

### 13.31. V2.4.1 Reminder Reliability Repair

Implemented:

```text
drizzle/0004_reminder_reliability_repair.sql
policy reconciler before every reminder claim
idempotent occurrence/reminder recovery
interval progression from occurrence.scheduledFor without delivery drift
one-immediate catch-up without missed-slot bursts
inclusive interval window ends
user and policy quiet hours
scheduler runtime health, /cronhealth and /policydebug
safe scheduler fields in /api/health
nested reminder policy setup and expanded snooze controls
Telegram cleanup audit with planner mutation explicitly forbidden
legacy diagnostics in /reminders and /longterm
owner-only preview/apply repair for circle, Drik, mirror and ЖКХ
```

Production rollout:

```text
implementation commit -> 9f80c4ab8a2697cc8fcac1955c3902c0131e8bc2
verified production commit -> 81188bb3d74745514836c6103eebef49ea456437
production health -> appVersion 2.4.1
new scheduler and policy schema objects -> read successfully by production
Telegram webhook -> pending 0, no last error
cron-job.org -> automatic successful runner observed
repair preview -> exactly four intended legacy groups
repair apply -> 4 items repaired, 4 policies created, no unrelated records changed
active policies -> 4
policies missing next reminder -> 0
circle and Drik catch-up slots -> advanced automatically from 10:00 to 10:30 Moscow
circle 10:30 reminder -> delivered automatically by cron-job.org
circle Done callback -> item completed, policy completed, future reminder cancelled
Drik catch-up snooze -> pending reminder rescheduled to 10:44 Moscow
mirror -> weekly long-term recurring_car policy
ЖКХ -> every_2_weeks long-term recurring_finance policy
OpenAI health -> real call succeeded with valid structured output and accepted tool definition
```

Validation:

```text
npm test -> 31 files passed, 95 tests passed
npm run lint -> passed
npm run build -> passed
```

Remaining limitation:

```text
Vercel project scope requires CLI/connector re-authentication; GitHub auto-deploy remains operational
```

### 13.32. V2.4.2 Transactional Reminder Semantics

Production incident:

```text
Snooze shifted the Drik interval grid from :00/:30 to :14/:44.
Near the end of the window duplicate deliveries appeared.
An expired interval task produced a post-event menu after midnight.
The Central Park request partially mutated production despite a validation failure.
An open-ended Drik request became a generic task without a working policy.
Tomorrow's one-day reminder was classified as long-term.
```

Implemented:

```text
distributed 55-second reminder runner lease in assistant.runtime_locks
reconciler-before-claim runner order
anchor-grid-v2 interval calculation based on policy.startsAt
one-off snooze reminders that do not move the policy grid
strict inclusive end-window handling with expire_silently default
atomic ActionPlan, planner item, policy, initial reminder and occurrence commit
pre-commit semantic validation for reminder policies
transaction telemetry for proposed and committed mutations
exact Central Park normalization to two events and four daily policies
open-ended Drik normalization to one task and one 08:00-22:00 nag_until_ack policy
dashboard sections for active, soon and distant reminders
owner-only /admin_repair_v242 preview|apply
/versiondebug and safe scheduler/version fields in /api/health
```

The first production preview additionally exposed two partial Central Park policies and one Drik
interval stored with the invalid `recurring` type. The repair filter was tightened to include those
exact known signatures before any mutation was applied.

The first corrected Central Park production attempt was atomically blocked by a validator false
positive: the word `утром` was treated as an imprecise window despite the explicit `с 8 до 12`
range. The validator now distinguishes a vague day-part from an explicit numeric clock/range.

A protected self-cleaning snooze probe was added because direct local Neon pooler connections are
unstable. It creates a temporary 10-minute interval policy, snoozes by 13 minutes, reports the
resulting timestamps and deletes the entire probe chain in `finally`.

Database rollout:

```text
drizzle/0005_transactional_reminder_semantics.sql applied idempotently
assistant.reminder_policies.on_window_end exists
assistant.runtime_locks exists
reminder occurrence and lock indexes exist
Neon pooler disconnected during the broad diagnostic read after DDL; the DDL notices confirmed all
objects were already present on retry, and runtime verification will confirm them through V2.4.2
```

Local validation:

```text
npm test -> 34 files passed, 105 tests passed
npm run lint -> passed
npm run build -> passed
```

Production deployment and acceptance are pending the GitHub/Vercel rollout of this working tree.
