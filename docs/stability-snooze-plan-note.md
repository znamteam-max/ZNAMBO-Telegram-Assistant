# Stability patch scope

This branch only addresses two observed regressions:

- stale `untilDoneCarryover` presentation after an explicit reschedule to today or later;
- collision spacing moving user-relative reminder targets such as `+2 hours` away from the requested instant.

No schema, webhook, wake-gate, PWA, or production-data repair changes are included.
