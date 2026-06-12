# ZNAMBO Telegram Assistant - Project Handoff

This is the single canonical file to attach to a new Codex chat after every deployment.
It contains the current production state, cumulative implementation history, validation results,
and remaining limitations. It must never contain secrets.

Last updated: 2026-06-12

## Current Production

```text
Application version: 2.5.4.1
Production URL: https://znambo-telegram-assistant.vercel.app
Validated application deployment commit: bd76bb2c4189f01051b6a63940c5b61af6b490b0
Pipeline: Jarvis / mandatory OpenAI for natural language
Policy engine: 2.5.3
Interval algorithm: anchor-grid-v2
Reconciler: enabled
Runner lock: enabled
Production scheduler: cron-job.org
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
```

## Remaining Limitations

- Calendar sync remains non-blocking by design.
- Historical calendar failures from the period before valid CalDAV configuration remain visible
  in safe diagnostics. They are not retried automatically unless explicitly requested.
- An independent Yandex UI check for duplicate legacy events still requires the owner; production
  retry acceptance proved that the existing object URL is reused.
- The destructive confirmation callback was covered by regression tests and deployed, but no
  intentional production item deletion was performed during acceptance.
- Vercel connector access to the team scope still returns 403; GitHub auto-deploy completed and
  was verified through the production health commit.

## Handoff Rule

After every production deployment:

1. Update this file with the deployed version and commit.
2. Record implementation changes and production acceptance results.
3. Record remaining limitations.
4. Verify no secrets are present.
5. Attach only this file to the next Codex chat.
