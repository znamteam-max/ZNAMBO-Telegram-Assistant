# ZNAMBO Telegram Assistant - Project Handoff

This is the single canonical file to attach to a new Codex chat after every deployment.
It contains the current production state, cumulative implementation history, validation results,
and remaining limitations. It must never contain secrets.

Last updated: 2026-06-17

## Latest Deployment - V2.21.0 Plan Visual Semantics, Owner Timezone and Multi-Event Reminder Template

Production application code commit: `9d8b5ccb2abe56277778e7e59f3e47fed306d0ad`

This deployment is a focused V2.21 corrective release on top of V2.20.0. It keeps the Jarvis
planner, mandatory OpenAI path, ActionPlan execution, Yandex Calendar integration, and cron-job.org
runner architecture intact.

Implemented:

- owner timezone is centralized as `Europe/Moscow`; owner-facing natural-language times without an
  explicit timezone parse in Moscow time, store UTC internally, and render back in Moscow time;
- planner item metadata records `sourceTimezone` when committing action plans;
- `/api/health` exposes safe timezone diagnostics, including `ownerTimezone`;
- protected `/admin_time_debug` and admin action `admin_time_debug` were added with safe UTC/local
  sample parse-render diagnostics;
- `/admin_repair_v2210 preview|apply` and protected `v2210_repair_preview|apply` were added as a
  calendar-safe repair wrapper for timezone candidates, monthly range audit, event follow-up
  visibility, and callback payload hardening;
- `/plan` / `/dashboard` now build a dedicated render model with compact rows, bold indexes,
  one concise reminder line per item, today's reminder markers, recurring long-term rule markers,
  and hidden background `after_event` noise in normal rows;
- event reminder-only follow-ups created from event cards are visible in item cards and, when due
  today, in the compact plan reminder line without moving the event time;
- event follow-up creation audit now includes safe event/reminder/scheduledAt/source details;
- before-event reminder offsets render human labels such as `za nedelyu`, `za 3 dnya`, and
  `za 2 dnya` instead of technical hour/minute offsets;
- the orthodontist multi-event reminder template is normalized into two event items with the same
  per-event reminder template, including same-day morning reminders at 08:00, 09:00, and 10:00
  local when valid;
- monthly day-range policies now audit checked/materialized/missed-review states with
  `assistant.monthly_day_range_occurrence_checked`,
  `assistant.monthly_day_range_occurrence_materialized`, and
  `assistant.monthly_day_range_occurrence_missed_review`;
- daily recurring requests without a time keep the existing first-class clarification draft UX.

Validation:

```text
Local validation:
npm test: 65 files passed, 351/351 tests passed
npm run lint: passed
npx tsc --noEmit: passed
npm run build: passed
git diff --check: passed; only CRLF warnings from Git
Changed-file secret scan: passed; only intentional fake redaction fixtures matched
Database migration: not required

Production health before handoff docs commit:
/api/health ok, appVersion 2.21.0
deploymentCommit 9d8b5ccb2abe56277778e7e59f3e47fed306d0ad
defaultTimezone Europe/Moscow, ownerTimezone Europe/Moscow
schedulerConfigured true, lastRunnerSucceeded true
lastRunnerRunAt 2026-06-17T14:54:10.919Z during protected gate run
policiesMissingNextReminder 0
OpenAI configured true, OpenAI required for natural language true

Telegram webhook:
ok true, expected URL configured, pending updates 0
safe warning: historical last_error remains visible from Telegram getWebhookInfo

AI health:
ok true, model gpt-4o-mini-2024-07-18
response id resp_0b10692f78ae3dba006a32b53682ac819e98affd74d3de1627
latency 3832 ms, structured output valid, test tool accepted

Admin time debug:
ownerTimezone Europe/Moscow
serverTimezone UTC
sample local time 2026-06-19T21:30:00
sample stored UTC 2026-06-19T18:30:00.000Z
sample rendered owner-facing time 19.06 21:30-22:30

V2.21 repair preview/apply/post-preview:
safeToApply true
policiesMissingNextReminder 0
repairablePolicies 0
expiredPolicies 0
reviewRequiredPolicies 0
todayUntilDoneItemsMissingDueAt 0
monthlyDayRangeSkippedTodayPolicies 0
missingEventFollowupReminders 0
callbackPayloadTooLongRecords 0
timezoneShiftedEvents 0
postilnyConcertCandidates 0
calendarObjectsToChange 0
calendarObjectsChanged 0
monthly day-range audit actions present

Reminder smoke:
smoke item f889b6a5-fba0-4466-b459-eb321041d2d6
scheduledAt 2026-06-17T14:57:11.181Z
deliveredAt 2026-06-17T14:58:11.754Z
reminderStatus sent, deliveryStatus sent, item autoArchivedAfterDelivery true
delivery was observed through the normal cron-job.org scheduler; no manual runner fallback used
```

Release notification:

```text
Sent: yes
Telegram message id: 1127
Sent at: 2026-06-17T15:01:36.852Z
Idempotency: second call returned already_sent with the same Telegram message id 1127
Safe warning recorded by release gate: historical_webhook_error
```

Remaining notes:

```text
No schema migration was required for V2.21.0.
Yandex Calendar remains best-effort and was not changed by V2.21 repair.
The V2.21 production repair found 0 real timezone-shifted or Postilny candidates during acceptance;
the invariant is covered by code, tests, and protected time diagnostics.
Owner live acceptance prompts for the Postilny concert, orthodontist pair, and /dashboard remain
optional manual checks after deployment; automated production gates passed.
Vercel MCP deployment listing returned a scope 403 in this Codex session, so deployment was verified
through production /api/health and the deployed Git commit instead.
```

## Previous Deployment - V2.20.0 Plan Rendering, Daily Policy, Event Follow-up and Button Safety

Production code commit: `347ade29566dafa4e258dc185fb8b5a2de4f5f84`

This deployment hardens the V2.19 planner without rewriting it. It focuses on the daily assistant UX
that showed up in production: noisy plan rendering, background post-event follow-up noise, monthly
range reminders skipping a valid current day, event reminder-only follow-ups, long Telegram callback
payloads, daily recurring requests without time, today task due consistency, and a production smoke
fixture that could be shifted by collision spacing.

Implemented:

- `/plan` / `/dashboard` rows now use compact numbered Telegram HTML rows with bold indexes and
  short `Today` / `Rule` reminder lines instead of repeated large bell markers;
- background `after_event` / `post_event_menu` follow-up policies are hidden from normal plan rows
  and only surface in a separate actionable block when due or overdue;
- before-event reminder copy normalizes `one hour` to `1 h` and de-duplicates multiple reminders
  into one compact line;
- monthly day-range recurring policies such as `monthly_days:15,16,17,18,19@12:00` can materialize
  the current valid day even if `nextFireAt` incorrectly points to a later date in the range;
- the reminder reconciler treats sent/acked/skipped occurrences as consumed and advances the policy
  instead of recreating the same occurrence;
- event extra reminder actions create reminder-only follow-ups and audit
  `assistant.event_followup_reminder_created` without moving the event time;
- daily recurring requests without a time are parsed as typed recurring intents and create a
  clarification draft instead of failing or creating a bad task;
- `today` reminder text without a specific time normalizes to a today task due at local `23:59`;
- callback payloads for multi-reminder mode, item-policy cancel, repeat-policy cancel, tomorrow
  snooze/confirm, and item importance now have short aliases, with old handlers kept for existing
  cards;
- safe audit actions added or extended: `assistant.plan_rendered`,
  `assistant.monthly_policy_materialized`, `assistant.event_followup_reminder_created`,
  `assistant.callback_payload_shortened`, `assistant.daily_recurring_missing_time_draft_created`,
  and `assistant.today_task_due_normalized`;
- `/admin_repair_v2200 preview|apply` and protected actions `v2200_repair_preview|apply` were added
  on top of the existing V2.19 repair flow. The repair is calendar-safe and reports Yandex objects
  to change as `0`;
- protected `reminder_smoke` now disables collision spacing and returns the actual reminder
  `scheduledAt`, so release acceptance proves delivery instead of a shifted fixture.

Validation:

```text
Local validation:
npm test: 64 files passed, 347/347 tests passed
npm run lint: passed
npm run build: passed
git diff --check: passed; only CRLF warnings from Git
Callback payload spot check: deadline/event/policy payloads <= 62 bytes, item importance alias 43 bytes
Changed-file secret scan: only existing fake redaction fixtures in release-notification tests;
no real secrets, API keys, bearer tokens, passwords, or connection strings added
Database migration: not required

Production health:
/api/health ok, appVersion 2.20.0
deploymentCommit 347ade29566dafa4e258dc185fb8b5a2de4f5f84
schedulerConfigured true, lastRunnerSucceeded true
lastRunnerRunAt 2026-06-17T11:36:12.777Z
policiesMissingNextReminder 0

Telegram webhook:
ok true, expected URL configured, pending updates 0
safe warning: historical_webhook_error remains visible from Telegram getWebhookInfo

AI health:
ok true, model gpt-4o-mini-2024-07-18
response id resp_0f64d3f0d1e45480006a32860d0118819e9514dce765009337
latency 1192 ms, structured output valid

V2.20 repair preview/apply/post-preview:
policiesMissingNextReminder 0
repairablePolicies 0
monthlyDayRangeSkippedTodayPolicies 0
missingEventFollowupReminders 0
callbackPayloadTooLongRecords 0
calendarObjectsToChange 0
calendarObjectsChanged 0
safeToApply true

Dashboard snapshot:
itemCount 7, policyCount 4
bold numbered rows true
repeated leading bell lines 0
Today label true, Rule label true
background post-event noise false

Agent probes:
daily missing-time probe called OpenAI and returned recurrenceRule daily, policyType recurring
today task probe called OpenAI and returned dueAtLocal 2026-06-17T23:59:00

Reminder smoke:
old shifted smoke item archived safely
new smoke item bb0f5732-11ee-4d31-9bce-9b32e8bc1f30
scheduledAt 2026-06-17T11:35:42.008Z
deliveredAt 2026-06-17T11:36:10.351Z
reminderStatus sent, deliveryStatus sent, item autoArchivedAfterDelivery true
delivery was observed after scheduler/cron-job.org runner, without manual runner fallback
```

Release notification:

```text
Sent: yes
Telegram message id: 1079
Sent at: 2026-06-17T11:36:43.693Z
Idempotency: second call returned already_sent with the same Telegram message id 1079
```

Remaining notes:

```text
No schema migration was required for V2.20.0.
Yandex Calendar remains best-effort and was not changed by V2.20 repair.
The monthly day-range and missing event follow-up production repair paths had 0 real production
candidates during acceptance; behavior is covered by local tests and safe repair counters.
Telegram getWebhookInfo still reports a historical last_error, but the webhook URL is correct,
pending updates are 0, health is ok, and runner is fresh.
```

## Previous Deployment - V2.19.0 Today Until-Done Task Due and Policy Audit

Production commit: `2d27fc13a7038b413dd60cd20cad79d088fd2d86`

This deployment completes V2.19.0 acceptance and includes a same-version production hotfix on top of
the initial V2.19 rollout commits. The hotfix was required because protected production acceptance
proved that a messy OpenAI proposal with two task-like actions plus an erroneous recurring reminder
could bypass the V2.19 today-until-done normalization.

Implemented:

- `today + until done` / `segodnya + poka ne sdelayu` task requests are forced into one today task
  due at local `23:59`;
- the same requests create one `nag_until_ack` policy with 60-minute default interval,
  `requireAck=true`, local window end `23:59`, and `onWindowEnd=move_to_overdue_or_review`;
- messy AI proposals that split the user intent into a task plus reminder task, or propose an
  `every_hour` recurring reminder, are collapsed into the correct one-task policy shape;
- today-until-done tasks stay in the Today task bucket instead of Long-term, including when old data
  has an attached until-done policy but no item due date;
- snoozed today-until-done policies render with local snooze state and still show the 23:59 window;
- `move to tomorrow` on a today-until-done task requires explicit confirmation;
- `/admin_repair_v2190 preview|apply` audits and repairs policies missing next reminders and
  today-until-done items missing due dates without changing Yandex Calendar objects;
- production repair materialization was hardened for existing reminder conflicts;
- release metadata and tests were updated for V2.19.0.

Validation:

```text
Local validation after final hotfix:
npm test: 63 files passed, 339/339 tests passed
npm run lint: passed
npx tsc --noEmit: passed
npm run build: passed
git diff --check: passed; only CRLF warnings from Git
Changed-file secret scan: passed; no matches
Database migration: not required

Initial V2.19 production repair before final hotfix:
preview found policiesMissingNextReminder 1, repairablePolicies 1
apply materialized 1 replacement reminder safely
post-apply preview returned policiesMissingNextReminder 0, repairablePolicies 0

Final production deploy:
GitHub push to main, Vercel auto-deploy
/api/health: ok, appVersion 2.19.0,
commit 2d27fc13a7038b413dd60cd20cad79d088fd2d86
schedulerConfigured true, lastRunnerSucceeded true,
policiesMissingNextReminder 0

Protected webhook status:
ok, URL https://znambo-telegram-assistant.vercel.app/api/telegram/webhook,
pending updates 0
safe warning: historical_webhook_error still visible from Telegram getWebhookInfo

Protected AI health:
ok, model gpt-4o-mini-2024-07-18,
response id resp_0ef41a60ad16fe29006a3272eb551881928d6924db9ebb2e70,
latency 1074 ms, structured output valid, test tool accepted

V2.19 repair preview/apply/post-preview after final hotfix:
policiesMissingNextReminder 0
repairablePolicies 0
expiredPolicies 0
reviewRequiredPolicies 0
todayUntilDoneItemsMissingDueAt 0
calendarObjectsToChange 0

Protected agent execution acceptance after final hotfix:
input: segodnya v2190 smoke alpha, napominay kazhdyy chas poka ne sdelayu
result: ok true, finalAction agent_execute_committed_action_plan
created one task: dueAt 2026-06-17T20:59:00.000Z, which is 23:59 Europe/Moscow
created one policy: nag_until_ack, intervalMinutes 60, requireAck true,
endsAt 2026-06-17T20:59:00.000Z, onWindowEnd move_to_overdue_or_review
test item was archived after verification

Reminder smoke after final hotfix:
created item becfcde2-cd5a-4177-9e0a-51c161bc85cb
scheduledAt 2026-06-17T10:10:44.620Z
delivered at 2026-06-17T10:11:08.775Z
reminder status sent, delivery status sent, smoke item auto-archived
cron-job.org remains the production scheduler; protected manual runner also returned ok
```

Release notification:

```text
Pending at the moment this handoff entry is committed.
It must be sent immediately after this handoff commit reaches production, because the release gate
checks the active production commit and handoff evidence.
```

Remaining notes:

```text
No schema migration was required for V2.19.0.
Yandex Calendar remains best-effort and was not changed by V2.19 repair.
The protected acceptance run intentionally found and fixed one admin agent_execute production bug.
The failed test item was archived; the successful post-hotfix test item was also archived.
Telegram getWebhookInfo still reports a historical 500 last_error, but the webhook URL is correct
and pending updates are 0.
```

## Previous Deployment - V2.18.0 Event Reminder Semantics Hotfix

Production commit: `4324c44720585121798aba6c64156ec2e39f287a`

This is a same-version V2.18.0 hotfix. It supersedes production commits
`8ca05a588c9b89e31727443a24c0dcae0a7d5f6c` and
`f1179fc9f5919937a9653fd3afad63defac59ef5` without changing the app version.

Implemented:

- event-like reminder notifications now render as `Напоминание о событии` /
  `Напоминание о тренировке`;
- event reminder cards use event-aware buttons: `Помню`, `Напомни ещё`, safe event snoozes,
  edit event, stop future reminders, and plan navigation;
- event reminder acknowledgement updates only the reminder occurrence and never completes,
  archives, or cancels the event;
- event snooze and `Напомни ещё` create reminder-only follow-ups before event start and never move
  the event start/end time;
- invalid event snooze buttons are hidden when they would fire after event start;
- `post_event_menu` / after-event policies render as `после события — спросить как прошло`
  instead of broken-policy noise;
- broken/review-required reminder policies are filtered out of normal item reminder lines and are
  available for a separate `Требует решения` dashboard block;
- live dashboard now separates `Сегодня — события`, `Сегодня — задачи`, `Сегодня — напоминания`,
  and adds the hint `Нажми номер, чтобы открыть пункт.`;
- runner-side due reminder collisions are spread by 5 minutes before claim, with
  `assistant.reminder_spacing_applied` audit rows;
- reminder creation spacing also writes `assistant.reminder_spacing_applied`;
- pending prompts use DB-backed `pending_prompt_renag_session` records and re-nag every 5 minutes
  until answered, cancelled, or expired;
- callback middleware now writes `assistant.callback_handled` with callback type, target ids,
  status, and safe user-facing response.

Validation:

```text
Local validation after final code change:
npm test: 330/330 passed
npm run lint: passed
npm run build: passed
git diff --check: passed before code commit
Changed-file secret scan: passed; matches were only env variable names and intentional fake fixtures
Schema migration: not required; hotfix uses existing tables/metadata

Production deploy:
GitHub push to main, Vercel auto-deploy
/api/health: ok, appVersion 2.18.0,
commit 4324c44720585121798aba6c64156ec2e39f287a
schedulerConfigured true, lastRunnerSucceeded true,
lastRunnerRunAt 2026-06-17T07:33:07.444Z

Protected webhook status:
ok, URL https://znambo-telegram-assistant.vercel.app/api/telegram/webhook,
pending updates 0

Protected AI health:
ok, model gpt-4o-mini-2024-07-18, response id present,
latency 1672 ms, structured output valid

V2.18 repair preview before apply:
generic before-event policies 0, duplicate before-event offsets 0,
past important events 0, stale reminder sessions 0, fake reminder rows 0,
calendar objects to change 0

V2.18 repair apply:
cancelled duplicate policies 0, inferred before-event policies 0,
review-required policies 0, cancelled invalid before-event policies 0,
marked past-review items 0, cleared reminder sessions 0,
cancelled fake reminder rows 0, calendar objects changed 0

V2.18 repair preview after apply:
all counts 0, calendar objects to change 0

Dashboard protected snapshot:
today sections rendered; post-event Winline policy rendered as
`после события — спросить как прошло, 17:00` instead of `требует проверки`

Reminder smoke:
created item 02151849-6673-45f2-9512-3cef7e8c2437
scheduledAt 2026-06-17T07:31:09.859Z
delivered by cron-job.org/runner at 2026-06-17T07:32:13.661Z
reminder status sent, delivery status sent, smoke item auto-archived

Release notification:
sent at 2026-06-17T07:33:18.091Z
Telegram message id: 991
Notification idempotency: verified; repeat protected call returned already_sent with message id 991

Final /api/health:
ok, appVersion 2.18.0,
commit 4324c44720585121798aba6c64156ec2e39f287a,
latestReleaseNotification V2.18.0 sent for the same commit
```

Remaining notes:

```text
No schema migration was required for this hotfix.
Yandex Calendar remains best-effort and was not changed by V2.18 repair.
Production release inspection records one safe warning: historical_webhook_error; webhook is healthy
with pending updates 0.
Health still reports policiesMissingNextReminder: 1. Runner is healthy and smoke passed; this remains
a non-blocking follow-up candidate for a later policy audit.
Protected read-only multi-action agent probe called OpenAI successfully. It was not used for DB
mutation during this hotfix acceptance.
Because reminder collision spacing is active, `/remindertest 2` / protected smoke may deliver later
than exactly two minutes if nearby pending reminders already occupy that slot.
```

## Previous Deployment - V2.17.0

Production commit: `ff62c69cee10acb025f6cdae5589a5fcd305b5cb`

V2.17.0 is deployed to production.

Implemented:

- target-resolution confirmation before silently updating similar same-slot events;
- owner buttons for same event rename+reminders, reminders-only, create separate, manual choose, cancel;
- bare before-event offset follow-ups now ask for a target when multiple future events are plausible;
- before-event reminder offsets render as one deduped line and do not show generic `one time` noise;
- `update_existing_items` + reminder policy execution no longer sends success and then a generic failure;
- important ended event-like items move to `Past - review` / `Прошло - решить` instead of `Important`;
- past-review item card actions: complete, reschedule, keep in plan, archive;
- `/admin_repair_v2170 preview|apply` and protected actions `v2170_repair_preview|apply`;
- release metadata and `/release_notes` updated to V2.17.0.

Validation:

```text
Local validation: npm test 306/306, npm run lint passed, npm run build passed
Changed-file secret scan: passed; only env variable names and intentional fake test fixtures matched
Production deploy: GitHub push to main, Vercel auto-deploy
/api/health after deploy: ok, appVersion 2.17.0, commit ff62c69cee10acb025f6cdae5589a5fcd305b5cb
Protected webhook status: ok, URL https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
Protected AI health: ok, model gpt-4o-mini-2024-07-18, response id present, latency 1605 ms
V2.17 repair preview before apply: duplicate before-event policies 1, generic before-event policies 0,
past-review items 1, stale target sessions 0, calendar objects to change 0
V2.17 repair apply: cancelled duplicate policies 1, review-required policies 0,
marked past-review items 1, cleared target sessions 0, calendar objects changed 0
V2.17 repair preview after apply: duplicates 0, generic 0, past-review 0, stale sessions 0,
calendar objects to change 0
Reminder smoke: delivered automatically by cron-job.org at 2026-06-16T16:46:12.578Z
Smoke item: auto-archived after delivery
Release notification: sent at 2026-06-16T16:48:01.339Z
Telegram message id: 946
Notification idempotency: verified; second protected call returned already_sent with message id 946
Final /api/health: ok, appVersion 2.17.0, commit ff62c69cee10acb025f6cdae5589a5fcd305b5cb,
latestReleaseNotification V2.17.0 sent, runner succeeded after protected /api/reminders/run
```

Remaining notes:

```text
No schema migration was required for V2.17.0.
Yandex Calendar remains best-effort and was not changed by V2.17 repair.
Production release notification recorded one safe warning: historical_webhook_error.
The target-resolution behavior is implemented and unit-covered; owner can still manually confirm the
live Telegram Winline prompt with a real message if desired.
```

## Previous Deployment - V2.16.0

Production commit: `f264eeaf0b7f0e367895b541ca34724207a27cdd`

V2.16.0 is deployed to production.

Implemented:

- dedicated `multi_reminder_setup_session` for multiple before-event reminders;
- reminder setup prompts are deduped through the policy-editor lifecycle;
- same-message event+relative reminders create attached policies;
- reminder-only follow-up messages attach to a recent future event;
- committed summaries count and list policy-created reminders;
- local mutation confirmation is shown before calendar feedback;
- ended event-like items leave active/important sections;
- daily history filters standalone fake reminder rows;
- `/admin_repair_v2160 preview|apply` for conservative local cleanup.

Validation:

```text
Local validation before acceptance: npm test 302/302, lint, TypeScript, build passed
Changed-file secret scan: passed
Protected webhook status: ok, production URL, pending updates 0
Protected AI health: ok, model gpt-4o-mini-2024-07-18, response id present
V2.16 repair preview before apply: safe true, fake reminder items 3, wrong Central Park time 0,
missing Winline/CP reminder items 0, past-important annotations 1, stale sessions 0,
calendar objects to change 0
V2.16 repair apply: cancelled fake reminder items 3, restored Central Park items 0,
created policies 0, created reminders 0, annotated past-important items 1, cleared sessions 0,
calendar objects changed 0
V2.16 repair preview after apply: safe true, fake reminder items 0, wrong Central Park time 0,
missing Winline/CP reminder items 0, past-important annotations 1, stale sessions 0,
calendar objects to change 0
Reminder smoke: delivered automatically by cron-job.org at 2026-06-16T13:40:17.931Z
Smoke item: auto-archived after delivery
Release notification: sent at 2026-06-16T13:41:16.639Z
Telegram message id: 922
Notification idempotency: verified; second protected call returned already_sent with message id 922
Final /api/health: ok, appVersion 2.16.0, commit f264eeaf0b7f0e367895b541ca34724207a27cdd,
latestReleaseNotification sent at 2026-06-16T13:41:16.639Z
```

Known V2.16 acceptance note:

```text
The post-apply preview still reports 1 past-important annotation candidate. The repair did annotate
that item and changed zero calendar objects, but the preview predicate still sees the original
important/priority marker. This did not block webhook, AI, repair, runner, or reminder-smoke gates.
```

## Previous Deployment - V2.15.0

Production commit: `abb71c88c4dc80657a2b1cbb2f5ea327433a7c4e`

Implemented:

- persistent `assistant.release_notifications` storage with unique version+commit+environment;
- release gate for health, exact version/commit, webhook, runner, migration/smoke evidence, and
  handoff completion;
- failed-send retry and duplicate-send protection;
- explicit opt-in for same-version hotfix notifications;
- `/version`, `/release`, `/release_notes`, `/changelog`, `/release_notify`;
- protected admin action `release_notify`;
- safe release metadata and health status;
- migration `drizzle/0009_release_notifications.sql`.

Validation:

```text
npm test: 58 files, 296 tests passed
npm run lint: passed
npm run build: passed
targeted V2.15 tests: 13 passed
git diff --check: passed
```

Production acceptance:

```text
Production migration: applied and verified
GitHub push and Vercel auto-deploy: passed
/api/health: ok, appVersion 2.15.0, deployment commit matched
Scheduler: configured, last runner succeeded and remained fresh
Telegram webhook: correct production URL, pending updates 0
Telegram historical last_error: 500 at 2026-06-15T12:49:48Z, before V2.15 deploy
Reminder smoke: delivered automatically by cron-job.org at 2026-06-15T20:19:09.419Z
Smoke item: auto-archived after delivery
Release notification: sent at 2026-06-15T20:20:30.517Z
Telegram message id: 868
Notification idempotency: verified; second call returned already_sent with message id 868
```

The release gate reported one safe warning: `historical_webhook_error`. The recorded Telegram
webhook error is from `2026-06-15T12:49:48Z`, before V2.15.0 deployment. The webhook URL matches
production, pending updates are zero, and the error timestamp did not advance during rollout.

## Current Production

```text
Application version: 2.21.0
Production URL: https://znambo-telegram-assistant.vercel.app
Validated application code commit: 9d8b5ccb2abe56277778e7e59f3e47fed306d0ad
Pipeline: Jarvis / mandatory OpenAI for natural language
Policy engine: 2.5.3
Interval algorithm: anchor-grid-v2
Reconciler: enabled
Runner lock: enabled
Production scheduler: cron-job.org
Owner timezone: Europe/Moscow
Calendar provider: Yandex CalDAV, best-effort
```

## Previous Deployment - V2.14.0

V2.14.0 fixes reminder UX, recurring duplicate safety, completed-item management, cleanup preview,
and audit hardening. It does not replace Jarvis, mandatory OpenAI planning, ActionPlan execution,
Yandex CalDAV, the production reminder runner, or cron-job.org scheduling.

Implemented:

- Weekly recurring reminders without a time now become typed clarification drafts. The bot does
  not create planner items, recurring policies, reminders, or action plans until the user chooses
  a time.
- Similar recurring reminders are detected before creation. The bot asks whether to update the
  existing policy, create a separate one, or cancel.
- Reminder menu labels were rewritten around user intent: concrete time, before event, repeat,
  nag until done, multiple reminders, advanced.
- Multiple reminders for one event are supported from one reply such as `za den v 9 utra, za 2
chasa i za 30 minut`; the same item receives several before-event policies and reminders.
- Event reminder rendering now shows concrete offsets such as `za den v 09:00`, `za 2 chasa`,
  `za 30 minut` instead of a generic before-event label.
- `/completed` and `/done` show completed items with pagination plus restore and archive actions.
  The bottom keyboard now has `Completed` and `Cleanup` entries.
- `/cleanup`, `/cleanup_chat`, and the cleanup keyboard show a preview first. They only clear
  transient Telegram UI messages after confirmation and never delete planner data or Yandex
  Calendar objects.
- Active past tasks are classified as overdue. `Unresolved` is now reserved for broken,
  imported, orphaned, or explicit review data.
- Missing recurring-time debug/audit fields now include failure reason, field name, and suggested
  next prompt.
- Added `/admin_repair_v2140 preview|apply` for safe production cleanup. It repairs stale drafts,
  duplicate mirror policies, generic before-event metadata, and hidden completed rows. It changes
  zero Yandex Calendar objects.
- Added protected admin API actions `v2140_repair_preview` and `v2140_repair_apply` for the same
  safe repair flow.
- No database migration was required.

## V2.14.0 Corrective Completion

A second line-by-line audit of the original V2.14 brief found that the first rollout covered the
core paths but missed several product acceptance details. The corrective implementation adds:

- add / replace / cancel choice when neutral multi-reminder text targets an event that already has
  before-event reminders;
- explicit additive and replacement modes, with replacement cancelling old policies and future
  reminders first;
- individual reminder rows and remove-one/remove-all controls on item cards;
- category-based cleanup for Telegram messages, completed items older than 30 days, stale drafts,
  and conservatively identified broken reminders;
- an expiring stored preview session before every cleanup confirmation;
- completed archive behavior that removes archived rows from `/completed`;
- explicit restore feedback that old reminder windows were not restarted;
- review-required rendering for unknown before-event offsets;
- non-empty failure reason, field, and suggested prompt for failed traces;
- committed/cancelled state normalization in agent action storage and actionlog output;
- V2.14 repair detection for contradictory recurring draft action rows.

The corrective implementation is deployed. GitHub `main` currently ends with the empty deployment
trigger commit `2c65854b1077fe939512fb70d3b0dd9caea85189`; the application deployment correctly reports
the preceding code commit `3a38f7cae332f0a177cf0a36b21f0e8295e7cda2`.

## V2.14.0 Validation Before Deploy

```text
npm test -> 57 files passed, 283 tests passed
npm run lint -> passed
npm run build -> passed
git diff --check -> passed
secret scan -> no live secret values found; README env placeholders only
database migration -> not required
```

## V2.14.0 Production Acceptance

```text
Production application commit: d7548a60bcdf6f340ca9fabe2bbc576a83745bf6
GitHub push and Vercel auto-deploy: passed
/api/health: ok, appVersion 2.14.0, deployment commit matched
Scheduler: configured, lastRunnerSucceeded true
Telegram webhook: ok, production URL, pending updates 0, no last error
OpenAI health: real call succeeded, model gpt-4o-mini-2024-07-18, structured/tool response ID present, latency 4724 ms
V2.14 repair preview before apply: safe true, generic before-event policies 1, calendar objects to change 0
V2.14 repair apply: applied safely, changed zero Yandex Calendar objects
V2.14 repair preview after apply: generic before-event policies 0, stale drafts 0, duplicate policies 0, completed invisible items 0
Reminder smoke: protected two-minute smoke delivered to Telegram, reminder status sent, delivery status sent at 2026-06-15T12:17:08.250Z, test item auto-archived
```

## V2.14.0 Corrective Production Acceptance

```text
Production application commit: 3a38f7cae332f0a177cf0a36b21f0e8295e7cda2
GitHub main trigger commit: 2c65854b1077fe939512fb70d3b0dd9caea85189
GitHub push and Vercel deployment: passed after one empty webhook-trigger commit
/api/health: ok, appVersion 2.14.0, deployment commit matched the corrective code commit
Scheduler: configured, final lastRunnerSucceeded true
Telegram webhook: production URL, pending updates 0
Telegram historical last_error: 500 at 2026-06-15T12:49:48Z, before corrective deploy; timestamp did not change after deploy
OpenAI health: real call succeeded, model gpt-4o-mini-2024-07-18, response ID present
V2.14 repair preview before apply: safe true, generic 0, stale drafts 0, duplicates 0, contradictory rows 0
V2.14 repair apply: passed, zero Yandex Calendar objects changed
V2.14 repair preview after apply: clean
Reminder smoke: delivered to Telegram at 2026-06-15T16:14:09.798Z, reminder and delivery sent, test item auto-archived
Local tests: 57 files, 283 tests passed
Lint: passed
Build: passed
Database migration: not required
```

## Previous Deployment - V2.13.0

V2.13.0 fixes command targeting, recurring draft integrity, safer snooze diagnostics, all-day edit
handling, and production action logging. It does not replace the mandatory OpenAI planner,
ActionPlan execution, reminder runner, Yandex CalDAV integration, or existing calendar import.

Implemented:

- Recurring reminders with canonical recurrence rules but missing time are blocked before
  `action_plans`, `planner_items`, `reminder_policies`, or `reminders` can be created.
- Recurring draft sessions now store a deterministic fingerprint and dedupe repeated incomplete
  requests. A duplicate request reuses the pending draft and explicitly says no new task was
  created.
- Global creation-intent session escape now preserves an active recurring draft long enough for
  dedupe, while `/cancel` still clears drafts and active edit sessions.
- Legacy V2 `executeActionPlanForMessage` gained the same missing-time draft guard as Jarvis.
- Item edit/reschedule context now treats `today all day` / `сегодня целый день` as an explicit
  all-day schedule for the selected item, with `allDay` / `timeGranularity: all_day` metadata.
- Snooze callbacks now write `assistant.reminder_snooze_attempt` audit rows and fall back to item
  snooze if policy snooze cannot resolve but the reminder still has an item target.
- Undo normalizes active scheduled event-like task snapshots such as orthodontist/meeting/broadcast
  items back to `event`, avoiding accidental movement into unresolved old tasks.
- Added `/actionlog`, `/actionlog 24h`, `/actionlog 50`, `/actionlog export`, and `/debugrecent`
  with secret redaction.
- Added `/admin_repair_v2130 preview|apply` and protected admin API actions
  `v2130_repair_preview` / `v2130_repair_apply`. The repair archives incomplete meter-reading
  draft leaks, cancels incomplete meter policies, clears stale sessions/drafts, fixes orthodontist
  target classification/policy attachment, and changes zero Yandex Calendar objects.
- No database migration was required.

## V2.13.0 Production Acceptance

```text
Production application commit: 5a558afd5a0065ecb815f2fc9ab6c66e7e7f7d4a
GitHub push and Vercel auto-deploy: passed
/api/health: ok, appVersion 2.13.0, deployment commit matched
Telegram webhook: ok, production URL, pending updates 0, no last error
OpenAI health: real call succeeded, model gpt-4o-mini-2024-07-18, structured output valid, response ID present, latency 2532 ms
V2.13 repair preview: incomplete meter items 0, incomplete meter policies 0, duplicate recurring drafts 0, stale sessions 0, orthodontist item already event-like, safe yes
V2.13 repair apply: archived 0 items, cancelled 0 policies, cleared 0 drafts/sessions, normalized 0 items, retargeted 0 policies, calendar objects changed 0
Recurring missing-time read-only probe: AI called, recurring_task proposed, rule monthly_days:15,16,17,18,19, startsAt null, no execution
Reminder smoke: protected two-minute smoke delivered to Telegram, reminder status sent, delivery status sent at 2026-06-15T09:51:07.483Z, test item auto-archived
Scheduler: cron-job.org / runner configured, lastRunnerSucceeded true after smoke
Local tests: 56 files, 266 tests passed
Lint: passed
Build: passed
git diff --check: passed
Secret scan: no live secrets added; only README env placeholders
Database migration: not required
```

Remaining V2.13 notes:

```text
The protected multi-action read-only probe called OpenAI and proposed the main Zoom event plus the
Z2 training. The current admin snapshot does not expose per-action reminders, so it did not prove
the 18:30 reminder from that endpoint. It also did not split the tentative short-video call into a
separate object in this probe. Treat that as the next smart-planner behavior gap, not as verified.
Bottom keyboard text commands are still deterministic hard commands in messageHandlers; this
release did not require a schema migration for them.
Yandex Calendar remains best-effort and must not block planner/reminder writes.
```

## Previous Deployment - V2.12.0

V2.12.0 cleans up recurring reminder UX after the V2.11 state-machine fixes. It does not replace
the mandatory OpenAI planner, ActionPlan execution, reminder runner, Yandex CalDAV integration, or
existing snooze system.

Implemented:

- Weekly recurring reminders with missing time remain typed drafts until the user explicitly chooses
  or provides a time; smart commit and policy execution now have missing-time guards.
- Russian natural reminder windows now parse `с 8 утра до 8 вечера`, `с восьми утра до восьми
вечера`, `с 10 утра до 6 вечера`, numeric `с 8 до 20`, and local end-of-day phrases.
- Editing cadence on a recurring item updates the recurring policy (`weekly:MO@08:00` plus
  interval/window metadata) instead of creating a one-day local nag window.
- The policy scheduler now supports recurring interval windows, so a weekly 08:00-20:00 hourly rule
  advances hourly inside the window and then to the next weekly window.
- Monthly `15-19 число` recurring reminders become typed drafts when time is missing and use
  `monthly_days:15,16,17,18,19@HH:mm` when time is present.
- Plan/reminder rendering no longer duplicates `❗` in row and detail, no longer prints `без
времени` for unscheduled recurring rows, and formats `300 мин` as `5 часов`.
- Item cards now include `❗ Маркер` controls with Auto / Show / Hide stored in item metadata.
- Recurring filler titles such as `О том, чтобы я решил вопрос...` normalize to human task titles.
- `/admin_repair_v2120 preview|apply` repairs the production mirror task/policies and moves the
  broken Fedotov reminder to review/paused without touching Yandex Calendar.
- `/debuglast` now reports recurring missing-time failures as field `time` with a safe next prompt.
- No database migration was required.

## V2.12.0 Production Acceptance

```text
Production application commit: 411aaea1f6872c566b128169a9d984b684f4f558
GitHub push and Vercel auto-deploy: passed
/api/health: ok, appVersion 2.12.0, deployment commit matched
Telegram webhook: ok, pending updates 0, no last error
OpenAI health: real call succeeded, structured output valid, tool call accepted
V2.12 repair preview before apply: 1 mirror item, 2 malformed mirror policies, 1 Fedotov policy, safe yes
V2.12 repair apply: renamed 1 item, normalized 1 target policy, superseded 1 duplicate, moved 1 Fedotov policy to review, calendar objects changed 0
V2.12 repair preview after apply: malformed 0, Fedotov 0, stale sessions 0
Dashboard snapshot: no "без времени", no "🔔 ❗", no Fedotov, no 02:59, no 300 мин
Monthly 15-19 agent probe: AI called, structured output valid, rule monthly_days:15,16,17,18,19, no start/due
Reminder smoke: runner endpoint sent 1 due reminder through /api/reminders/run; health later showed schedulerConfigured true and lastRunnerSucceeded true
Local tests: 55 files, 262 tests passed
Lint: passed
Build: passed
git diff --check: passed
Database migration: not required
```

Remaining V2.12 notes:

```text
The repair and probes were run through protected production diagnostics. The exact Telegram
multi-turn monthly draft conversation and marker button clicks were covered by automated tests and
server-side probes, not manually driven in the owner chat during this rollout.
cron-job.org remains the production scheduler; the V2.12 smoke reminder was completed by an
explicit protected runner call, while health confirms the scheduler is configured and the last
runner pass succeeded.
Yandex Calendar remains best-effort and must not block planner/reminder writes.
```

## Previous Deployment - V2.11.0

V2.11.0 fixes the reminder setup state machine and stale-session routing without replacing the
mandatory OpenAI planner, ActionPlan execution, reminder runner, CalDAV integration, or recurrence
engine.

Implemented:

- Active reminder setup now keeps collected fields across turns.
- In reminder setup, `do kontsa dnya`, `do kontsa segodnyashnego dnya`, and `do 23.59` fill the
  reminder window end as local `23:59`.
- Full phrases like `s 20.00 kazhdye 30 min, poka ne otmechu, do kontsa segodnyashnego dnya`
  apply immediately to the selected item.
- `otmena`, `/cancel`, `cancel`, `stop`, `zakryt`, `vyiti`, and `ne nado` clear active edit,
  reminder setup, recurring draft, and external calendar edit sessions.
- New weekly/monthly/global reminder creation intents escape stale item-edit/reminder sessions and
  continue through the mandatory AI planner.
- Reminder setup mutates only reminder policies/reminders, not unrelated task due/start/end fields.
- `/admin_repair_v2110 preview|apply` safely restores the known World Cup recap task deadline to
  2026-06-14 23:59 Europe/Moscow, normalizes the intended 30-minute reminder policy, clears stale
  sessions, and changes zero Yandex Calendar objects.
- `/debuglast` now includes a safe suggested next prompt for recurring tool failures.
- No database migration was required.

## V2.11.0 Production Acceptance

```text
Production application commit: 7598f93e8877722c625f1a0fbc957a2d4e48ff53
GitHub push and Vercel auto-deploy: passed
/api/health: ok, appVersion 2.11.0, deployment commit matched
Telegram webhook: ok, pending updates 0, no last error
OpenAI health: real call succeeded, model gpt-4o-mini-2024-07-18, response ID present
V2.11 repair preview: 1 target task, wrong dueAt detected, 1 intended policy, safe yes
V2.11 repair apply: updated 1 item, normalized 1 policy, detached 0, cleared 0, calendar objects changed 0
V2.11 repair after apply: wrongDue false, alreadyExpected true
Planner snapshot: World Cup recap dueAt 2026-06-14T20:59:00.000Z, no wrong 15.06 08:00 dashboard block
UTF-8 monthly probe: recurring_task, rule monthly_days:15,16,17,18,19, no item update
UTF-8 weekly timed probe: recurring_task, rule weekly:MO@10:00, requireAck true, no item update
Automatic reminder smoke: sent through cron-job.org, delivery status sent, test item auto-cancelled
Local tests: 54 files, 247 tests passed
Lint: passed
Build: passed
git diff --check: passed
Database migration: not required
```

Remaining V2.11 notes:

```text
The reminder setup state machine and session escape are covered by automated tests and production
probes. The exact multi-turn Telegram reminder-setup conversation was not manually driven in the
owner chat during this rollout.
Vercel CLI is unavailable locally, but GitHub auto-deploy was verified through the live health
commit and runtime acceptance endpoints.
Yandex Calendar remains best-effort and must not block planner/reminder writes.
```

## Previous Deployment - V2.10.0

V2.10.0 completes recurring reminder execution without replacing the mandatory OpenAI planner,
ActionPlan, reminder runner, or CalDAV integration.

Implemented:

- Weekly weekday reminders use canonical rules such as `weekly:MO@10:00`.
- Monthly day-range reminders use one logical rule such as
  `monthly_days:15,16,17,18,19@12:00`.
- Missing reminder time creates a typed draft and targeted clarification instead of a generic
  failed-closed response.
- Multi-reminder messages preserve separate action titles and policies.
- Cadence-only phrases such as `Каждый понедельник` cannot become task titles.
- Reminder setup accepts stop-condition-only replies such as `Пока не выполню` and asks only for
  the next missing interval or window field.
- Weekly and monthly policies advance after delivery in the user's timezone.
- `сегодня до конца дня` and `завтра до конца дня` resolve to local 23:59.
- `/debuglast` includes safe recurring tool failure reason and field.
- `/admin_repair_v2100 preview|apply` archives only the known cadence-title garbage task and its
  generated policy, with no Yandex Calendar deletion.
- No database migration was required.

## V2.10.0 Production Acceptance

```text
Production application commit: 6abad3f886dabfbcc1e2bb15ace86fbb0d12caeb
GitHub push and Vercel auto-deploy: passed
/api/health: ok, appVersion 2.10.0, deployment commit matched
Pipeline: jarvis, OpenAI configured and required for natural language
OpenAI health: real call succeeded, structured output valid, tool call accepted
Weekly missing-time probe: recurring_task, rule weekly:MO, requireAck true
Weekly timed probe: recurring_task, rule weekly:MO@10:00, requireAck true
Monthly range probe: recurring_task, rule monthly_days:15,16,17,18,19
Multi-reminder probe: two recurring_task actions and two separate recurrence rules
End-of-day probe: task due 2026-06-14T23:59:00 Europe/Moscow
Telegram webhook: correct production URL, pending updates 0, no last error
V2.10 repair before apply: 1 cadence-title task, 1 generated policy, safe yes
V2.10 repair apply: archived 1 task and 1 policy, calendar objects changed 0
V2.10 repair after apply: 0 tasks and 0 policies
Automatic reminder smoke: sent to Telegram and test item auto-archived
cron-job.org runner: last run succeeded, policiesMissingNextReminder 0
Local tests: 53 files, 234 tests passed
Lint: passed
TypeScript: passed
Build: passed
git diff --check: passed
Secret scan: passed
Database migration: not required
```

Remaining V2.10 acceptance:

```text
The read-only production probes prove the same mandatory OpenAI normalization path. The owner has
not yet manually completed the Telegram time-selection draft for a new weekly/monthly policy.
Vercel connector deployment listing lacks the project team scope; production was verified through
the live health commit and runtime acceptance endpoints.
```

## Latest Deployment - V2.9.0

V2.9.0 fixes deadline semantics without rewriting the mandatory OpenAI planner, reminder policy
engine, runner, or CalDAV integration.

Implemented:

- Deadline phrases such as `дедлайн завтра до 14:00`, `сдать до`, `успеть до`, weekday deadlines,
  and explicit dates create a task with `dueAt`.
- Deadline-only tasks have no invented `startAt/endAt` block. A task can still have both an
  explicit work interval and a later deadline.
- Plan and task cards render scheduled time and deadline separately. Deadline-only tasks cannot be
  classified as `Сейчас / идёт`.
- Future deadlines offer `Утром`, `За 2 часа`, and `За 30 минут`; same-day deadlines offer
  `Скоро`, `За час`, and `За 30 минут`. No reminder is auto-created.
- Item-card edits support setting, changing, clearing, and combining a deadline with a work block.
- Project names are conservatively normalized, including `Больше`, `Централ Парк`, and `ЧМ-26`.
- `/admin_repair_v290 preview|apply` repairs only the exact known June 14 deadline misparse and
  never deletes a Yandex Calendar object.
- No database migration was required; the existing separate `start_at`, `end_at`, and `due_at`
  fields are used.

## V2.9.0 Production Acceptance

```text
Production application commit: 9de4c1a53c2160b447e10899e0eb40c3eec76b3c
GitHub/Vercel deployment: passed
/api/health: ok, appVersion 2.9.0, deployment commit matched
Pipeline: jarvis, OpenAI configured and required for natural language
Exact production AI probe: AI called and succeeded, response ID present, structured output valid
Probe result: one task, title normalized to эфир Больше, startAt null, dueAt June 15 at 14:00
Telegram webhook: correct production URL, pending updates 0, no last error
V2.9 repair before apply: 1 exact candidate, safe yes, calendar updates needed 0
V2.9 repair apply: same item updated, calendar objects changed 0
V2.9 repair after apply: 0 candidates
Planner snapshot: repaired task has startAt null, endAt null, dueAt 2026-06-15T11:00:00Z
Plan snapshot: Пн, 15.06 до 14:00 visible; accidental 12:00-14:00 range absent
Automatic reminder smoke: sent to Telegram and test item auto-archived
cron-job.org runner: succeeded after final deployment
Local tests: 52 files, 217 tests passed
Lint: passed
TypeScript: passed
Build: passed
git diff --check: passed
Secret scan: passed
Database migration: not required
```

Remaining V2.9 acceptance:

```text
The inline deadline reminder buttons are covered by automated tests and deployed, but were not
manually clicked in the owner's Telegram chat during this rollout.
```

## Latest Deployment - V2.8.0

V2.8.0 makes reminder policies understandable in Plan, adds real policy-level snooze, fixes
cadence-only edit context, and hardens the reminder runner.

Implemented:

- `/plan` and `/dashboard` render Plan directly instead of replying with a navigation placeholder.
- Reminder policies render inline under their tasks with human wording, weekdays, and a visible
  marker for persistent until-ack policies.
- Reminder-edit sessions apply cadence-only replies to the selected item; global cadence-only text
  asks for a target instead of creating a garbage task.
- Policy/item snooze is enforced during claim, reconciliation, materialization, and the final
  pre-delivery check. High-frequency rules offer 30-minute, one-hour, two-hour, and tomorrow
  snooze choices.
- Normal reminders expose Done, snooze, and item-edit controls.
- Complex three-reminder requests produce one three-intent confirmation preview.
- `/admin_repair_v280` safely archives the known cadence-only garbage task and its generated policy
  without deleting Yandex Calendar data.
- A production-only PostgreSQL claim regression caused by locking a nullable outer-join side was
  found after deployment and fixed with `NOT EXISTS`.
- The complex-request normalizer now accepts plural `показания счётчиков`; an integration test
  proves the real mandatory OpenAI proposal path returns three actions.

## V2.8.0 Production Acceptance

```text
Production application commit: d2ccd86f5cc4b74144b0938513e78f4bcf23757d
GitHub CI: passed
Vercel production deployment: passed
/api/health: ok, appVersion 2.8.0, deployment commit matched
Pipeline: jarvis, OpenAI configured and required for natural language
Production Neon migration: drizzle/0008_reminder_policy_snooze.sql applied
Verified columns: planner_items.snoozed_until, reminder_policies.snoozed_until,
reminder_policies.snooze_scope
Reminder runner: completed successfully after deployment
Reminder reconciler: 1 active policy, 0 policies missing next reminder
Telegram webhook: correct production URL, pending updates 0, no last error
V2.8 repair final preview: 0 garbage cadence tasks, 0 garbage cadence policies, 0 stale sessions
Complex production AI probe: AI called and succeeded, structured output valid, 3 recurring tasks
Probe mutation count: 0; the read-only probe did not create user records
Automatic reminder smoke: reminder sent to Telegram and test item auto-archived
Yandex import: configured, latest import error none
Local tests: 51 files, 203 tests passed
Lint: passed
TypeScript: passed
Build: passed
git diff --check: passed
```

Remaining V2.8 acceptance:

```text
Owner interaction is still required to visually confirm `/plan`, `/dashboard`, reminder-edit
context, and each snooze callback in Telegram. These were not claimed as manually accepted.
Monthly day-range reminder policies still require confirmation before commit.
```

## Latest Deployment - V2.7.0

V2.7.0 restores clear reminder capture and makes imported Yandex Calendar data useful instead of
noisy.

Implemented:

- Exact-time, relative one-time, and open-ended hourly nag-until-ack reminder requests are
  normalized after the mandatory OpenAI proposal and no longer hit a generic ambiguity block.
- The planner guard accepts open-ended nag policies and returns precise missing-field messages.
- Imported service/test and ended past Yandex events are hidden from the default Plan; real future
  events remain visible.
- Plan buckets and conflict detection ignore hidden, service, and ended past events.
- `/calendar_cleanup preview|apply`, `/calendar_view`, and `/admin_repair_v270 preview|apply` safely
  change only the local JARVIS view. They do not delete real Yandex events.
- Plan and `/reminders` reconcile active reminder policies before rendering.
- Safe health diagnostics now include transcription, natural-language planning, and planner-guard
  status without message text or secrets.
- Calendar reads remain best-effort and cannot block the core Plan.

## V2.7.0 Production Acceptance

```text
Production application commit: 0038d8fb516fdf3ef347fd96af2e7a16bda7fe06
GitHub validate check: passed
Vercel production deployment: passed
/api/health: ok, appVersion 2.7.0, deployment commit matched
Pipeline: jarvis, OpenAI configured and required for natural language
New transcription/planner-guard health diagnostics: present
Telegram webhook route: reachable and reports endpoint ok
Telegram getWebhookInfo: requires protected owner/admin acceptance
Scheduler/reminder runner: lastRunnerRunAt advanced during a 65-second observation, succeeded
Reminder reconciler: policiesMissingNextReminder 0
Yandex import: configured, latest import error none
External calendar events visible after default hygiene: 1
Calendar cleanup/repair commands: require owner Telegram acceptance after deploy
Local tests: 49 files, 187 tests passed
Lint: passed
Build: passed
git diff --check: passed
Secret scan: passed; only the known local Drizzle fallback URL matched the URL pattern
Database migration: not required
```

Remaining limitations:

```text
The today_future and future_30_days calendar visibility modes currently share the bounded imported
calendar cache. Recurring external Yandex occurrences still cannot be edited individually.
Owner Telegram acceptance remains for `/calendar_cleanup preview`, `/admin_repair_v270 preview`,
`/plan`, `/reminders`, one clear reminder text, and one voice reminder.
```

## Latest Deployment - V2.6.0

V2.6.0 is the Plan UI and Yandex inbound-calendar release.

Implemented:

- Plan rows no longer show red/green/yellow urgency circles. Current events have their own section,
  while visible star/fire importance is explicitly editable as none, important, very important or
  auto.
- Item cards have a compact default menu. Technical sync/debug/history actions live under `Ещё`,
  and callbacks prefer in-place card updates when Telegram allows them.
- Persistent bottom navigation provides Plan, Add, Tasks, Reminders and Settings.
- Compound edits preserve explicit end times, understand ranges such as `с 19.00 до 20.00`,
  interpret a future same-day bare evening hour safely, accept rename text without quotes, and
  show full old/new values.
- Inbound Yandex CalDAV import uses `REPORT calendar-query`, parses ICS, expands weekly recurrence
  occurrences, skips JARVIS-synced object URLs, stores external events separately and merges them
  into Plan without creating duplicate local planner items.
- External Yandex cards support inspection, local hide, delete-everywhere, and editing/rescheduling
  of single non-recurring events at the same object URL.
- `/calendar_sync`, `/calendar_import_status`, bounded 15-minute background import and safe health
  telemetry were added. Calendar failures remain best-effort and cannot block reminders.
- A production `BUTTON_DATA_INVALID` regression caused by external-event callback data exceeding
  Telegram's 64-byte limit was found during reminder acceptance and fixed with a short wire alias.

## V2.6.0 Production Acceptance

```text
Production URL: https://znambo-telegram-assistant.vercel.app
Validated application code commit: 8506145e6f281cd12c69941664e4bf69a38c9810
/api/health: ok, appVersion 2.6.0, pipelineMode jarvis
OpenAI configured: true
OpenAI required for natural language: true
Real OpenAI health: succeeded, structured output valid, tool call accepted
Yandex Calendar: configured, authorization ok, write ok, create/read/delete test passed
Inbound calendar import: succeeded
External events visible: 38
Recurring occurrences imported: 32
Last calendar import error: none
Production Plan snapshot: 23 items, 1 policy, no red urgency circles
Telegram webhook: correct production URL, pending updates 0, last error none
Reminder runner: succeeded
Post-fix production reminder smoke: claimed 1, sent 1, failed 0, delivery sent, auto-archived
Production database migration: external_calendar_events and calendar_import_state verified
Local tests: 48 files, 176 tests passed
Lint: passed
TypeScript/build: passed
Secret scan: passed
```

Remaining limitation:

```text
Recurring external Yandex series can be shown, hidden or deleted as a whole series. Editing a
single occurrence or rewriting a whole recurring series from Telegram is not implemented yet.
```

## Latest Deployment - V2.5.4.1

V2.5.4.1 fixes item-card edit context. The bot no longer treats a natural-language reply to a
specific opened card as a global numbered-list operation.

Implemented:

- `manage:edit` and `manage:reschedule` create active item edit sessions in `assistant.agent_actions`.
- Natural-language replies inside an active edit session run before Jarvis hard-management routing.
- Compound item edits support title rename, date/time move, event-like kind inference, hourly
  `nag_until_ack` reminders until done, preview confirmation, calendar best-effort sync, dashboard
  refresh, conflict hints, and Undo.
- Russian date parsing handles Monday/Tuesday forms, explicit `15.06`, `10.20`, and past same-day
  confirmation.
- Slash commands clear stale edit sessions so `/dashboard` and `/plan` render the requested view.
- The dashboard moves active same-day past items out of upcoming Today and into unresolved.

## V2.5.4.1 Production Acceptance

```text
Production URL: https://znambo-telegram-assistant.vercel.app
Validated runtime commit: bd76bb2c4189f01051b6a63940c5b61af6b490b0
/api/health: ok, appVersion 2.5.4.1, pipelineMode jarvis
Telegram webhook URL: correct production endpoint
Telegram webhook pending updates: 0
Telegram webhook last error: none
Automatic scheduler: lastRunnerRunAt advanced after deployment
Runner succeeded: true
Dashboard snapshot: ok, 4 items, 0 policies
Manual Telegram item-card edit smoke: not run to avoid mutating live tasks without explicit user action
Local tests: 47 files, 166 tests passed
Lint: passed
TypeScript: passed
Build: passed
```

## Latest Deployment - V2.5.4

V2.5.4 replaces the today-only dashboard with one unified Plan and fixes the destructive
numbered-operation incident.

Implemented:

- `/plan` and `/dashboard` now show today, tomorrow, the next seven days, conflicts, important
  work, long-term work, unresolved work, and reminder rules from the canonical timeline.
- `/tasks` uses the same canonical item source and provides numeric cards plus management actions.
- `/reminders` is explicitly a reminder-rule screen and links back to Plan and Tasks when empty.
- Item cards show human-readable type, reminders, importance, and calendar provider/label/status.
- Committed batches receive one optional post-create triage card.
- Event overlap detection uses `A.start < B.end && B.start < A.end`, appears after mutations, and
  never blocks creation.
- Numbered deletion is bound to one latest concrete `viewId`, creates a preview, and requires an
  explicit callback confirmation.
- `5,6,7,8` remains a list, only `5-8` is a range, and `10.00-11.00` cannot become item indices.
- Mixed delete plus time update is previewed as one exact operation before any mutation.
- Confirmed deletion refreshes Tasks and Plan and exposes Undo.
- Repeat-policy deletion asks whether to remove only the rule or the task and rule.
- Added conservative `/admin_repair_v254 preview|apply` and protected read-only acceptance probes.
- CalDAV, mandatory OpenAI ActionPlan, the reminder engine, reconciler, runner lease, and
  anchor-grid interval logic were not rewritten.

## V2.5.4 Production Acceptance

```text
Production URL: https://znambo-telegram-assistant.vercel.app
Validated runtime commit: 8fd00ad51014977fb0e7ac346b1b08e7519d33ef
/api/health: ok, appVersion 2.5.4, pipelineMode jarvis
OpenAI configured: true
OpenAI required for natural language: true
Telegram webhook URL: correct production endpoint
Telegram webhook pending updates: 0
Telegram webhook last error: none
Automatic scheduler: lastRunnerRunAt advanced after deployment
Runner succeeded: true
Policies missing next reminder: 0
Plan snapshot: 4 visible items
Planner snapshot: 4 visible items
Plan with empty today: shows two tomorrow items and upcoming orthodontist
Conflict detection: orthodontist overlaps Central Park and is visible in Plan
Reminder center: "Правила напоминаний", explains rule scope, links to /plan and /tasks
V2.5.4 repair preview: 4 retained, 0 restore, 0 archive
Repair apply: not needed and not run
Local tests: 46 files, 158 tests passed
Lint: passed
TypeScript: passed
Build: passed
Secret scan: passed
```

## Latest Deployment - V2.5.3.1

V2.5.3.1 makes normal event synchronization resilient without changing the planner or reminder
architecture.

Implemented:

- Normal sync now shares the hardened low-level CalDAV client used by `/calendar_test`.
- Normal events use one deterministic object URL and a matching ICS UID.
- Added separate request, read-back, and total sync timeouts with real HTTP aborts.
- Immediate timeout preserves the planner item and creates an idempotent `pending_retry` job.
- Retry first GETs the same object URL and PUTs only after confirmed not-found.
- The existing minute runner processes a bounded calendar retry batch.
- Added `/calendar_retry_failed`, event-card retry/debug/disable controls, and V2.5.3 repair.
- Added safe normal-sync and retry metrics to `/calendardebug`.
- Fixed Russian unresolved-item pluralization.
- Applied and verified `drizzle/0006_calendar_sync_resilience.sql` in production Neon.

## V2.5.3.1 Production Acceptance

```text
/api/health: appVersion 2.5.3.1, runner healthy
Yandex CalDAV test: authorization/create/read/delete all passed
Orthodontist repair: 1 candidate before, synced, 0 candidates after
Normal sync: synced, no current error
Automatic retry probe: pending_retry -> minute runner -> synced
Automatic retry preserved external ID and cleared last error
Pending calendar retries: 0
Telegram webhook: pending updates 0, no last error
Local tests: 44 files passed, 149 tests passed
Lint: passed
TypeScript: passed
Build: passed
Secret scan: passed
```

## Previous Deployment - V2.5.3

V2.5.3 is a focused production hotfix on top of V2.5.2.

Implemented:

- Added canonical `buildUserTimelineView` for tasks, dashboard, reminders, and long-term views.
- Added an `unresolved_past` bucket for active work older than 48 hours.
- `/tasks` no longer displays old unresolved records as a long raw overdue list.
- Dashboard displays one compact unresolved-past block.
- Strengthened `/admin_repair_v252 preview|apply` and made it idempotent.
- Fixed the orthodontist event to June 16, 2026 at 10:20 Europe/Moscow.
- Archived one stale Drik duplicate.
- Moved old unresolved records into daily history state.
- Changed `/cleanup_garbage` into a safe preview instead of blind deletion.
- Added safe `/admin_state_v252`.
- Added safe Yandex CalDAV error classes.
- Added `/calendardebug` and `/calendar_test`.
- CalDAV collection URLs are normalized and deterministic `${uid}.ics` object URLs are generated
  before writes.
- CalDAV create, read-back, and cleanup now use the exact same object URL and do not depend on a
  `Location` response header.
- CalDAV read-back requests explicitly accept `text/calendar` and retry short-lived Yandex 404s.
- Read-back 404 is reported as `read_back_not_found`; object URL construction failure is reported
  as `calendar_object_url_build_failed`.
- `/calendardebug` exposes only safe URL-source and object-presence diagnostics.
- A successful `/calendar_test` clears stale displayed calendar errors.
- Event cards and mutation replies show calendar sync status.
- Added a semantic guard so an orthodontist request cannot bind to a Drik task that only mentions
  Rob.

## V2.5.3 Production Acceptance

```text
/api/health: passed
Telegram webhook: pending updates 0, no last error
OpenAI health: real call passed, structured output valid
Repair preview before apply: 1 orthodontist, 1 Drik duplicate, 5 old overdue records
Repair apply: orthodontist fixed, Drik duplicate archived, 4 old records moved to history state
Repair preview after apply: all target counts 0
Dashboard: compact unresolved-past block with 4 records
Reminder smoke: delivered through cron-job.org and test item auto-archived
Exact orthodontist agent execution: canonical orthodontist item updated, 0 new items created
Yandex CalDAV production test: authorization/create/read/delete all passed
Calendar debug: hasCalendarUrl true, authorization ok, write ok, status verified, no last error
Final local tests: 41 files passed, 135 tests passed
Lint: passed
TypeScript: passed
Build: passed
Secret scan: passed
```

## Calendar Status

```text
Provider: Yandex CalDAV
Configured: yes
Calendar URL source: YANDEX_CALDAV_CALENDAR_URL
Collection URL normalized: yes
Deterministic object URL created: yes
Authorization: ok
Create: ok
Read-back: ok
Delete cleanup: ok
Write verification: verified
Safe error class: none
```

Production create/read/delete verification passed on June 12, 2026. Planner items and Telegram
reminders continue working when calendar sync fails because calendar integration remains
best-effort by design.

## Reminder Delivery

cron-job.org calls:

```text
POST https://znambo-telegram-assistant.vercel.app/api/reminders/run
```

Automatic delivery and `/remindertest 2` have been confirmed in production.
Cloudflare Worker remains an optional fallback and does not block production.

## Architecture Summary

```text
Telegram webhook
-> owner allowlist and update idempotency
-> conversation/transcript persistence
-> memory facts, summaries, and retrieval context
-> mandatory OpenAI agent execution for natural language
-> multi-action ActionPlan
-> planner items, reminder policies, occurrences, and reminders
-> live dashboard and entity management cards
-> best-effort calendar sync with visible status
-> cron-job.org minute runner
```

## Version History

```text
V2.0.0 - Smart AI planner foundation
V2.1.0 - Production rollout and reminder delivery
V2.2.0 - Jarvis observability and mandatory OpenAI path
V2.3.0 - Agent execution and production safety
V2.4.0 - Reminder Policy Engine
V2.4.1 - Reminder policy reliability and repair
V2.4.2 - Atomic reminder semantics, reconciler, runner lock, anchor grid
V2.5.1 - Compact control, timeline classification, campaign semantics
V2.5.2 - Universal editability, temporal safety, Russian weekday repair
V2.5.3 - Production repair enforcement and deterministic Yandex CalDAV lifecycle
V2.5.3.1 - Normal CalDAV sync resilience and idempotent retry queue
V2.5.4 - Unified Plan UX, safe numbered mutations, triage and conflict detection
V2.5.4.1 - Item-card edit sessions, compound edits and Russian date fixes
V2.6.0 - Plan UI and Yandex inbound calendar import
V2.7.0 - Reminder capture regression fix and calendar import hygiene
V2.8.0 - Reminder policy UX, real policy snooze and Plan routing
V2.9.0 - Deadline semantics, due-task rendering and safe production repair
V2.10.0 - Weekly/monthly recurring execution, typed clarification and local end-of-day semantics
V2.11.0 - Reminder setup state machine and session escape fixes
V2.12.0 - Recurring UX cleanup, markers and monthly drafts fixes
V2.13.0 - Command targeting, draft integrity and action log fixes
V2.14.0 - Reminder UX, multi-reminders, completed-item controls and audit hardening
V2.15.0 - Release notification flow and deploy completion gates
V2.16.0 - Multi-reminder setup, event-relative reminder routing and safe repair
V2.17.0 - Target resolution, reminder offsets and past-event review
V2.18.0 - Event reminder semantics, today plan buttons and spacing fixes
V2.19.0 - Today until-done task due semantics and policy audit repair
V2.20.0 - Plan rendering, daily policy, event follow-up and button safety
V2.21.0 - Plan visual semantics, owner timezone and multi-event reminder templates
```

## Remaining Limitations

- Calendar sync remains non-blocking by design.
- Historical calendar failures from the period before valid CalDAV configuration remain visible
  in safe diagnostics. They are not retried automatically unless explicitly requested.
- An independent Yandex UI check for duplicate legacy events still requires the owner; production
  retry acceptance proved that the existing object URL is reused.
- The destructive confirmation callback was covered by regression tests and deployed, but no
  intentional production item deletion was performed during acceptance.
- Vercel connector team listing is not available in this session; GitHub auto-deploy completed and
  was verified through Vercel commit status and the production health commit.

## Handoff Rule

After every production deployment:

1. Update this file with the deployed version and commit.
2. Record implementation changes and production acceptance results.
3. Record remaining limitations.
4. Verify no secrets are present.
5. Attach only this file to the next Codex chat.
