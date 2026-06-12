# ZNAMBO Codex Cumulative Export - 2026-06-12

This file is a secret-free operational handoff for the ZNAMBO Telegram Assistant.

## Current Release

Target: V2.5.3

Production before the hotfix:

```text
appVersion: 2.5.2
production commit: 1c209e03d2aba32dff95eb0f191d7df685819555
policy engine: 2.5.2
interval algorithm: anchor-grid-v2
reconciler and runner lock: enabled
```

The production snapshot confirmed 12 visible active planner items, an orthodontist event still on
2026-06-13, stale/duplicate Drik intent, five unresolved records from June 7-9, and a planner event
whose Yandex CalDAV write result was not visible.

## V2.5.3 Changes

- Canonical user timeline and unresolved-past handling after 48 hours.
- Idempotent production repair with audit snapshot.
- Safe garbage preview and production-state diagnostic.
- CalDAV authorization/write/read/delete verification.
- Read-back verification for normal Yandex Calendar sync.
- Per-item calendar state and explicit sync feedback.

## Scheduler

cron-job.org remains the production minute scheduler for `POST /api/reminders/run`.
Cloudflare Worker remains optional.

## Security

No API keys, bot tokens, database connection strings, passwords, bearer secrets, or authorization
headers are included in this export.

## Production Acceptance

```text
V2.5.3 deployed
active tested code commit: febedb885f05b4512dbce25d216b186b64aaf7f4
health and webhook: ok
production repair: applied and idempotent
dirty repair candidates after apply: 0
dashboard: compact unresolved-past block
reminder smoke: delivered and auto-archived
OpenAI exact orthodontist execution: canonical item updated, no duplicate created
CalDAV create/read/delete test: blocked at authorization with safe auth_failed
```

The only external blocker is Yandex CalDAV authentication. A valid Yandex app password is required;
no credential value is stored in this export.
