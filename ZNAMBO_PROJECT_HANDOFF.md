# ZNAMBO Telegram Assistant - Project Handoff

This is the single canonical file to attach to a new Codex chat after every deployment.
It contains the current production state, cumulative implementation history, validation results,
and remaining limitations. It must never contain secrets.

Last updated: 2026-06-15

## Current Production

```text
Application version: 2.13.0
Production URL: https://znambo-telegram-assistant.vercel.app
Validated application deployment commit: 5a558afd5a0065ecb815f2fc9ab6c66e7e7f7d4a
Pipeline: Jarvis / mandatory OpenAI for natural language
Policy engine: 2.5.3
Interval algorithm: anchor-grid-v2
Reconciler: enabled
Runner lock: enabled
Production scheduler: cron-job.org
```

## Latest Deployment - V2.13.0

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
