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
- [x] T2: Store installment calendar days as DATE; strict YYYY-MM-DD validation/response; overdue only before the business day.
- [ ] V: Required build, lint, and full tests observed; report failures/skips honestly.

## Verification
Required: npm.cmd run build; npm.cmd run lint; npm.cmd test; npm.cmd run test:e2e only against verified local bazar_test. No reset/migration or remote DB. Service tests use mocks without DB.
Runtime harness: functional service/component tests. Rollback boundary: each behavioral commit and its tests/docs independently; DATE conversion is intentionally lossy and cannot restore historical hours.

## Progress
T1 verified: focused RED 7 failed / 2 passed; GREEN 9 passed. Build passed; lint passed with two pre-existing warnings in test/sales-conflict.e2e-spec.ts. T1 commit: 8b7d2a12511b1dc89c8c049c42c1c3ea91eb2e33. Engram mirror saved but readback unavailable (ambiguous project); synchronization pending verification.

## Next step
Independent verification, then separately authorize and provision a local test database to apply migration and rerun e2e. No remote recreation authorized.

T2 evidence: RED 6 failed / 4 passed, GREEN 10 passed; additional null regression RED 1 failed / 11 passed, GREEN 12 passed. Final build/lint passed; full unit suite 26 files / 377 tests passed. E2E run and elevated retry both failed because local bazar_test at 127.0.0.1:5433 is unavailable: 27 files failed, 10 tests failed, 556 skipped. No migration/reset/recreation was executed. DATE migration structural checks passed, actual migration execution remains pending. T2 commit: fda506a20422551b163df42947811d4fb6a356b5.
