# Minimal fixes — 2026-09-03

Baseline: `9e1ba5871f3f8a1190f3507a0e6a02e7d6771e56`.
No production data repair, migration, webhook/wake-gate/PWA change is authorized.

## FIX 1 — explicit snooze runner spacing

Root cause: the raw pre-claim collision UPDATE ranked all pending occurrences and
reassigned their timestamps relative to each runner's `now`. It neither excluded
explicit snoozes nor persisted a once-per-occurrence spacing marker. The write-time
sub-minute precision hotfix did not run on this SQL path and is left unchanged.

The runner now recognizes snooze purpose/payload/idempotency identity, pins explicit
and previously spaced occurrences, and persists originalDesiredAt, finalScheduledAt,
userExplicitSnooze, spacingAlreadyApplied. Existing write-time spacing metadata is
respected. Automatic collisions still move; NULL policy joins no longer suppress
their eligibility accidentally. Update guards prevent repeat application to a changed row.
Markers are scoped to the idempotency occurrence key. New reminder payloads reset
inherited spacing metadata without changing the slot-selection/write-time hotfix;
recurring successors cannot inherit the previous occurrence's snooze or spacing lock.

Files: src/db/queries/reminders.ts; src/tests/reminderRunnerSpacing.test.ts;
src/tests/helpers/reminderTestDb.ts; package.json/package-lock.json (test-only PGlite).

Tests run the actual production SQL on isolated in-memory PostgreSQL; no DATABASE_URL
or Neon connection. PGlite API: https://pglite.dev/docs/api .
Coverage: +30/+60/+120/+240, tomorrow 08:00, legacy event snooze, automatic collisions,
second/third runner passes, legacy spacing payload, no cumulative drift.

Validation: 75 test files / 424 tests passed; lint passed; build passed (Next 16.2.6);
git diff --check passed. Vitest does not require/support Jest's --runInBand flag.
