# Finance contributions

## Objective and authorized scope

Record money a Member delivers to the business, independently of sales, profit, ownership, compensation and automatic capital recovery. Implement only Contributions in bazar-api and bazar-frontend. No expenses, shifts, distributions, reserves, loans, capital recovery or sales changes. No merge, push, remote operations, production Docker or deploy.

## Architecture and acceptance

- Explicit tenant-scoped immutable Contribution; integer MXN cents; client UUID v7; contributor distinct from authenticated recording Member and Device.
- Socio-only administration using existing guards. Contributor references must belong to the same context. UI starts with socios as requested; confirm target role validation consistently in implementation.
- Stable normalized creation fingerprint: exact replay returns the existing receipt, changed content returns conflict.
- Explicit unique reversal of an original; optional linked replacement applied atomically. A reversal corrects a record and is not capital repayment. Preserve originals and actor/reason/time.
- Durable origin-scoped financial queue/history, no credentials in payloads. Persist before success; preserve original account/API/member/device and economic date; reconcile pending and confirmed by identity without double counting.
- IndexedDB upgrade preserves pending-sales and catalog-snapshot, including legacy operations. No blind reuse of the sales queue.
- Minimal responsive Finance > Contributions management UI, using existing Atomic Design and monetary/date controls.

## Execution and delivery

- Branch: feat/finance-contributions in both repositories. API base d4fdbc0; frontend base ae962c9.
- TDD: on for new behavior, from user instruction to apply TDD when reasonable and existing backend post-BE05 policy. Observe RED, GREEN and REFACTOR. Runners: Vitest (`npm.cmd test`, `npm.cmd run test:e2e`; frontend `npm.cmd run test:run`).
- Delivery strategy: ask-on-risk; user selected feature-branch-chain. Local work-unit commits only; future PRs are not authorized. No cosmetic shrinking to fit review size.
- Forecast: roughly 1,500–2,500 authored changed lines including tests/docs, to refine after implementation. Plan cohesive API creation/list, API corrections, offline persistence/sync, and UI slices; record exact commit boundaries/counts. About 400 lines per task is advisory, never an acceptance criterion.
- RDD: backend off (clone-local); frontend unknown (mode output off but command exited 1 for untrusted Git ownership); do not enable or launch native reviews. Native risk assessment plus independent verification for high/unassessable changes remains applicable.

## Tasks

- [x] FC1 — Backend contribution creation/listing, schema/migration/tenant RLS, permissions, validation, replay and filters with tests/docs.
- [ ] FC2 — Backend auditable reversal and atomic replacement, concurrency/idempotency tests/docs.
- [ ] FC3 — Frontend durable scoped financial persistence and synchronization with backwards-compatible IndexedDB upgrade and tests.
- [ ] FC4 — Responsive contributions management UI, existing components, filters, create/reverse/correct and tests/docs.
- [ ] FC5 — Full relevant verification, independent audit, parent spot check, fix confirmed in-scope defects and record final limitations.

## Required checks

- API: `npm.cmd run lint`; `npx.cmd tsc --noEmit -p tsconfig.build.json`; `npm.cmd test`; `npm.cmd run test:e2e`; `npm.cmd run build`; `git diff --check`.
- Frontend: `npm.cmd run lint`; `npx.cmd vue-tsc -b`; `npm.cmd run test:run`; `npm.cmd run build`; `git diff --check`.
- Run focused tests first. Read existing test setup and use only isolated test databases; never reset dev/production data, read secrets into output or send real emails.
- Record exact command/results including environmental failures; no claim of success for unavailable checks. All source-mutating normalization precedes final verification.

## Progress and recovery

Tracking created before source edits. No implementation yet. Engram mirror: odd/finance-contributions/tasks (bazar-api), locator bazar-api/odd/tasks/finance-contributions.md. Workers must read and update this document, preserve earlier completed work and attach commit/evidence. Next: FC1 then FC2 via one bounded writer; frontend follows the verified API contract.

### FC1 evidence

- DTO RED: 6 passed / 1 failed (sub-millisecond timestamp accepted); GREEN: 7/7 after restricting persisted instants to millisecond precision. Initial HTTP attempt was environmental, not RED: test DB unavailable, 13 skipped.
- Authorized isolated postgres-test service started; only local bazar_test migrated. SQL BOM caused first migration failure before any statement; removed BOM and marked that test-only attempt rolled back, then deploy/provision succeeded. No dev/production database changed.
- HTTP harness: npm.cmd run test:e2e -- test/contributions.e2e-spec.ts: 13/13 passed.
- Rollback boundary: finance creation/list module, Contribution table, tenancy registration, new tests/docs; no sales changes. Full suite checks follow FC2.
- Engram mirror readback remains unavailable due outer-workspace ambiguity; preserve local tracker.
