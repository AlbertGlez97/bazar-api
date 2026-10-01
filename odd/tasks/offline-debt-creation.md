# Offline debt creation: backend prerequisite

PR 1 implements safe client-idempotent debt creation. PR 2 remains blocked until the user explicitly confirms PR 1 is in main.

## Scope and authority

- Repository/branch: bazar-api / feat/debt-client-idempotency.
- Branch point: fe62bd4cf502c55f390a5fd0565a7db613f701cf.
- TDD enabled by explicit user instruction: RED -> GREEN -> REFACTOR. Runner: npm test (Vitest).
- Authorized: backend debt DTO/service/schema/additive migration/tests/API documentation and local atomic commits after passing full e2e.
- Authorized local environment: Docker Desktop development/test compose, test migrations/runtime-role provisioning; fictional-data bazar_dev and bazar_test may be cleaned/recreated if necessary after validating exact local targets. No reset was needed or performed.
- No frontend changes, other databases/unrelated containers, production deployment, remote access, push, PR creation or merge.
- RDD off by clone-local setting; ordinary verification only. Technical artifacts use English.

## Problem and decisions

The direct online debt creation path generated server IDs; retrying an ambiguous network failure could duplicate the debt, inline debtor, initial payment, schedule and inventory decrement. Cash-sale idempotency is the reference pattern.

Accept an optional validated client UUID for backward compatibility. Persist a SHA-256 fingerprint of original input and originating account/tenant/member/device; persist the immutable original JSON response in the same transaction. Reauthorize before tenant-scoped replay. Same ID/input returns the original result without writes, including after later payments or metadata changes; changed input returns 409. Historical debts have no receipt and fail closed. Public debt responses omit fingerprint/snapshot; no authentication token is stored.

Known debt-ID uniqueness/business-validation failures reread a committed winner because a concurrent loser may fail stock validation before reaching uniqueness. Preserve unrelated errors. A globally occupied ID with no tenant-visible winner returns generic 409 without inspecting or exposing the other tenant.

Insufficient stock without a matching winner remains HTTP 400; future offline clients retain definitive rejection as needs_review. Initial payment stays in the creation transaction. Later payments deliberately remain online-only: they need separate retry identities and balance-conflict semantics, not an overlooked TODO.

## Tasks

- [x] D1: Implement idempotency with tests first: validated/legacy IDs, original replay, changed-input 409, actor/context isolation, immutable result and concurrent winner recovery; schema/migration/contract/tests included.
- [x] D2: Verify backend and record proof, accepted size exception and authorized atomic delivery evidence.
- [ ] D3: Frontend queue extension — BLOCKED until explicit human confirmation PR 1 is in main. Reuse IndexedDB, UUID v7, online detection, reconnect sync and pending count; initial payment atomic; definitive conflicts remain needs_review.

## Proof and environment

- Initial RED: focused idempotency command exited 1, 16 failed / 1 passed before production edits; initial GREEN 19 passed.
- Collision refinement RED: 1 failed / 19 passed; final GREEN: npm test -- src/deudas/deudas-idempotency.spec.ts, 20 passed, exit 0.
- Historical e2e attempt: local test PostgreSQL unreachable, exit 1 / 26 skipped. Resolved by expressly authorized local setup; mock proof was never represented as real transaction proof.
- Explicit local Docker Desktop Linux named pipe; effective compose validated bazar_dev at loopback5432 and bazar_test at loopback5433. compose up -d --wait --wait-timeout 90 succeeded; both project services healthy.
- npm run db:migrate:test passed: pending 20261001160000_installment_calendar_date and 20261001180000_debt_client_idempotency applied only to bazar_test; dedicated RLS-enforced test runtime role provisioned. No dev/prod migration, reset/recreation/seed/volume deletion.
- Writer full npm run test:e2e: 27 files / 570 passed, exit 0, no skips. Includes four fiado/apartado concurrent scenarios at stock 1/2: one stock decrement/debtor/initial payment/schedule, matching responses, changed-input 409, original replay after later payment.
- Final npm run build / npm run lint / npm test / git diff --check: exit 0; full units 27 files / 397 passed. Two lint warnings in unchanged test/sales-conflict.e2e-spec.ts; expected injected-error logs and pg query deprecation warnings, no failing tests.
- Independent verifier reran debt HTTP suite: 28 passed / zero skipped; parent focused spot-check: 20 passed; independent diff-check passed.
- Local Prisma generation and source normalization preceded final verification. Source bytes unchanged since verified.

## Delivery and rollback

Strategy: ask-on-risk; selected chain: stacked-to-main. PR 1 backend -> human confirmation of main integration -> PR 2 frontend.
User accepted size:exception for the cohesive backend unit (reported 594 authored lines / 524 excluding the then-current recovery document). One honest slicing pass retained indispensable schema/behavior/tests together; no code-golf.
Initial forecast: backend 500-750 authored additions+deletions, frontend 350-550 to refine after integration; generated Prisma output excluded.
PR 1 boundary: branch point through backend work-unit commits; identities recorded after commit. PR 2 starts from frontend main only after the gate.
Rollback boundary: debt DTO/service/schema/additive migration/regression tests/API contract. Revert its work-unit commits without unrelated changes; assess stored receipt data before any reverse migration. Applied only to isolated test, not dev/prod.

## Recovery and next step

Engram mirror: bazar-api, odd/offline-debt-creation/tasks; locator: odd/tasks/offline-debt-creation.md. Full file/mirror readbacks reconciled.
Current delivery: parent proof accepted; create the authorized atomic feature commit, record its identity in a narrow evidence commit, then report readiness. No push or PR created.
Next: await human push authorization; do not start PR 2 until explicit confirmation PR 1 is in main.
