# История проекта ZNAMBO Telegram Assistant

Обновлено: 2026-06-01, Europe/Moscow.

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
