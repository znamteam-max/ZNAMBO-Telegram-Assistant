# ZNAMBO Telegram Assistant - Project Handoff

This is the single canonical file to attach to a new Codex chat after every deployment.
It contains the current production state, cumulative implementation history, validation results,
and remaining limitations. It must never contain secrets.

Last updated: 2026-06-12

## Current Production

```text
Application version: 2.5.3
Production URL: https://znambo-telegram-assistant.vercel.app
Active deployment commit: 2493eb26e0f783210d71cef150258ca9498f06fa
Pipeline: Jarvis / mandatory OpenAI for natural language
Policy engine: 2.5.3
Interval algorithm: anchor-grid-v2
Reconciler: enabled
Runner lock: enabled
Production scheduler: cron-job.org
```

## Latest Deployment - V2.5.3

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
- Normal CalDAV sync now verifies writes with a read-back GET.
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
Final local tests: 41 files passed, 130 tests passed
Lint: passed
Build: passed
Secret scan: passed
```

## Calendar Status

```text
Provider: Yandex CalDAV
Configured: yes
Authorization: failed
Write verification: failed
Safe error class: auth_failed
```

The Yandex app password must be corrected outside the repository before create/read/delete
verification can pass. Planner items and Telegram reminders continue working when calendar sync
fails.

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
V2.5.3 - Production repair enforcement and CalDAV write verification
```

## Remaining Limitations

- Yandex CalDAV currently returns `auth_failed`; a valid Yandex app password is required.
- One future reminder-like item remains an orphan candidate and was intentionally not
  auto-archived because it may be a real user task.
- Calendar sync remains non-blocking by design.

## Handoff Rule

After every production deployment:

1. Update this file with the deployed version and commit.
2. Record implementation changes and production acceptance results.
3. Record remaining limitations.
4. Verify no secrets are present.
5. Attach only this file to the next Codex chat.
