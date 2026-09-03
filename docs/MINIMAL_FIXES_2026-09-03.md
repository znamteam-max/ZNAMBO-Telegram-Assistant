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

## FIX 2 — ActionPlan event timezone normalization

Broken boundary: model-produced ActionPlan *Local fields were unrestricted strings;
the agent creation path sent them to executeActionPlanForMessage/createStoredActionPlan
without verifying the source clock. For example 15:00 (UTC wall clock with its offset
lost) was accepted as 15:00 Moscow and materialized as 12:00Z. localIsoToUtcDate itself
works correctly; the direct-edit path already parses source text in the user's zone.
The historical production JSON was not fetched: the exact original model value is
not claimed as independently observed. This failing input and boundary are reproduced
locally against the existing materializer.

Added a source-authoritative single-event clock guard both at agent normalization and
immediately before plan validation/storage. It reuses the direct-edit Russian datetime
parser; ambiguous multi-clock/multi-event, explicit foreign-zone, and reminder-only
messages are left to their existing interpretation. End duration and relative reminder
offsets are preserved. The guard is idempotent, respects explicit-today confirmation,
and never applies a fixed +3-hour shift. AI schema descriptions now state the contract.

The actual materializer and ICS serializer were only exported for regression tests;
their behavior and all formatters/direct-edit/target-lock code are unchanged.
Invariant: Moscow local 18:00 -> 15:00Z -> displayed 18:00 -> Yandex ICS 15:00Z.
Tests include New York and Kolkata, UTC/offset-bearing inputs, repeated normalization,
pre-storage ActionPlan JSON capture and ICS parse round-trip.

Files: src/ai/actionPlanEventTime.ts, src/ai/agentExecutionNormalization.ts,
src/ai/schemas.ts, src/bot/messagePipeline.ts, src/services/actionPlanCommit.ts (export),
src/integrations/yandexCalendar.ts (export), src/tests/actionPlanEventTimezone.test.ts,
src/tests/atomicAgentExecutionV242.test.ts.

Validation: 76 files / 435 tests passed; lint passed; build passed; diff check passed.
One parallel test/build run exceeded an existing 5-second dynamic-import test timeout;
the full suite passed in isolation without changing the test or its timeout.
