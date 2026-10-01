# Date/time corrections

## Objective and scope
Reduce legitimate-sale clock-skew noise and represent planned installments as calendar days, never instants. User authorized both corrections after investigation. No remote access, database recreation, migration application, deployment, push, PR, or merge.

## Decisions and constraints
- Future sales: strict greater than five minutes; equality accepted. Past: strict greater than two days, unchanged.
- Installments: PostgreSQL DATE with API YYYY-MM-DD. Reject invalid calendar dates. Convert historical timestamps using their UTC calendar day, preserving the existing editor encoding.
- Overdue: installment day strictly before today in the established UTC-06:00 business timezone; today's installments are not overdue. Abonos remain instants.
- TDD ON: explicit current user instruction. Runner: npm.cmd test (vitest run). Observe focused RED, GREEN, then refactor.
- Atomic work-unit commits on fix/date-time-corrections. RDD: off (clone-local); never enable or repair.
- Forecast: approximately 450 authored changed lines. Delivery strategy ask-on-risk; no PR planning or remote delivery authorized.

## Tasks and acceptance
- [x] T1: Tolerate future sale clocks up to five minutes; preserve the two-day past boundary; human-readable incident reason.
- [ ] T2: Store installment calendar days as DATE; strict YYYY-MM-DD validation/response; overdue only before the business day.
- [ ] V: Required build, lint, and full tests observed; report failures/skips honestly.

## Verification
Required: npm.cmd run build; npm.cmd run lint; npm.cmd test; npm.cmd run test:e2e only against verified local bazar_test. No reset/migration or remote DB. Service tests use mocks without DB.
Runtime harness: functional service/component tests. Rollback boundary: each behavioral commit and its tests/docs independently; DATE conversion is intentionally lossy and cannot restore historical hours.

## Progress
T1 verified: focused RED 7 failed / 2 passed; GREEN 9 passed. Build passed; lint passed with two pre-existing warnings in test/sales-conflict.e2e-spec.ts. Work-unit commit identity will be recorded after commit. Engram mirror saved but readback unavailable (ambiguous project); synchronization pending verification.

## Next step
T2: write quota regression tests, observe RED, then implement DATE/calendar API.
