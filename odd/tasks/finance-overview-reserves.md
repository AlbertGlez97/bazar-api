# Finance overview and planned reserves

## FO1 closure

FO1 completed in local commit 1c84f77e03561546b9ccddb192d896e627ab7d99 (1079 authored additions). Current checks: 17 unit tests, 270 HTTP/impersonation tests, lint/build typecheck/build/diff check passed. Parent reran 8 overview HTTP tests. User authorized starting only existing postgres-test; no creation/recreation/provisioning occurred. Native assessment medium/slice_budget_reached; user granted review. Reliability review found no confirmed candidate-caused findings; exact acknowledgement succeeded with authority burned for review-8e7eada7a648c96e. Reviewed boundary now 1c84f77e03561546b9ccddb192d896e627ab7d99. Earlier blocked/partial notes are historical and superseded. Next task FR1 persisted create/list reserves; FR2 reversal behavior remains pending. Engram mirror pending.

## Parent verification update

FO1 remains partial: independent inspection found no confirmed code blocker and focused unit tests passed 17/17, also rerun by parent. Build typecheck passed independently. Required HTTP/RLS tests cannot run: local port 5433 unreachable, Docker Desktop Linux engine unavailable. Only the declared postgres-test service is relevant; existing container presence is unknown until engine recovery. Await user restoring Docker Desktop and resolve service authorization before infrastructure actions. FR1/FR2 not started; no commits, native review, frontend edits or remote operations. Engram mirror remains pending registration. This update supersedes any earlier next-step instruction to close FO1 without HTTP/RLS evidence.

## Objective and authorization

Implement Phase 4 exclusively in bazar-api on feat/finance-overview-reserves. Expose recorded operating result, planned reserves and potentially available amounts, without asserting cash availability or distributable profit.

## Constraints and design

- No frontend, partner distribution, shift compensation, capital recovery, push, merge, deployment, Cloudflare, external services or remote operations.
- Sales minus known sold-item cost equals recorded gross margin; minus operating expenses equals recorded operating result; minus active exact-period reserves equals potentially available amount. Preserve negative values.
- Inventory purchases, contributions and nonmonetary shifts are separate. Missing sale costs make downstream results partial; never backfill costs.
- Strict calendar from-inclusive/to-exclusive periods; business fixed UTC-06 boundaries. Sales/expenses/contributions use occurredAt; shifts use workDate. Existing receivedAt reports remain unchanged.
- Persist immutable FinanceReserve and reversal facts with UUIDv7, tenant/audit attribution, stable fingerprints and immutable replay receipts. Socio-only overview and reserve administration using existing guards.
- API supports ingest/replay; browser durable queue, local pending projection and offline snapshot are explicitly outside backend-only scope. Return SERVER_CONFIRMED metadata, generatedAt and non-cash/non-withdrawable disclaimers.
- Delivery strategy: exception-ok, explicitly confirmed by user; one local branch with coherent small commits, no PR. Estimated 1550-2200 authored lines, generated excluded. 400 lines is advisory, not a correctness constraint.
- RDD effective on/global observed. Native risk, candidate consent and exact provider transitions apply per work-unit boundary. Parent owns review lifecycle.
- Engram mirror pending: host session registration could not be confirmed. Do not invent/register an identity or claim persistence.

## Tasks and acceptance

- [x] FO1: Recorded overview with economic periods, cost coverage, financial/nonmonetary totals, permissions, coherent transaction snapshot and tests/docs.
- [ ] FR1: Persistent period reserves, tenant migration/RLS, create/list, immutable replay/conflict handling, overview reserve integration and tests/docs.
- [ ] FR2: Reserve reversals, exact replay/double-reversal and concurrency checks; complete regressions and frontend contract documentation.

Each task uses delegated direct execution: unfamiliar financial flow plus multiple nontrivial files triggers preparation/writer delegation. Single writer only. Use deterministic RED -> GREEN -> REFACTOR when runnable; report environmental blocks honestly. A task closes only with observed checks and a conventional local commit, without AI attribution. Parent records risk/review status and commit after verification.

## Verification

- Focused DTO/service tests and HTTP/RLS tests covering costs, periods, negative/empty results, separated inventory/contributions, shifts, reserves and reversals.
- npm.cmd run prisma:generate; npm.cmd run db:migrate:test (only prevalidated localhost bazar_test, no reset/drop).
- npm.cmd test; npm.cmd run test:e2e (finance/report/impersonation regressions and full suites).
- npm.cmd run lint; npx.cmd tsc --noEmit -p tsconfig.build.json; npm.cmd run build; git diff --check.
- Normalize only authorized touched source before verification/review freeze. No mutating formatting after native START.

## Progress and boundaries

- Branch created from 1df181e46a16e62a9a0df3b2f7adb1943f9979bc; initial worktree clean.
- Read-only exploration and parent business-time/DTO spot check completed. FO1 implementation written; checkbox remains pending parent verification/commit/review accounting.
- Current FO1 results and environmental limitations are recorded below; no historical result is treated as current proof.
- Running authored line count: 0. Commits: none. Reviewed boundary: branch point above.
- Rollback: revert only feature work-unit commits; additive reserve migration must not be applied outside isolated local test database in this task.

## Next step

FR1 writer implementation and required checks pass; parent readback/spot check, work-unit commit and native review accounting are pending. Preserve FO1 reviewed boundary 1c84f77e03561546b9ccddb192d896e627ab7d99. FR2 cancellation HTTP/replay/double-cancellation/concurrency behavior remains unimplemented. Engram mirror remains pending.

## FO1 writer evidence (pending parent closure)

- Route: delegated direct; preparation/new financial logic/multiple nontrivial files. No commit, remote action or native review was performed by the writer.
- Implemented socio-only strict economic-period overview, tenant callback RepeatableRead snapshot, all completed revenue less known costs, cost coverage, separate active expenses/contributions/nonmonetary shifts and negative results. Reserves are temporarily zero with explicit pending warning; exact-period contract is documented, persistence/endpoints pending FR1/FR2.
- Cost arithmetic uses BigInt with controlled HTTP 422 safe-number boundary. No existing money helper/report semantics changed. Early years 0001-0099 are corrected after existing business-start parsing to avoid Date.UTC's century remapping.
- Deterministic RED: `npm.cmd test -- src/finance/finance-overview.dto.spec.ts src/finance/finance-overview.service.spec.ts` against placeholder implementation: exit 1, 4 failed / 9 passed (13 tests); missing-module run preceded this and is not assertion-level RED evidence.
- GREEN after implementation/refinement/normalization: same command exit 0, 17 passed, 2 files.
- `npm.cmd run test:e2e -- test/finance-overview.e2e-spec.ts test/impersonation-matrix.e2e-spec.ts`: exit 1 before fixtures, 2 suites failed / 270 tests skipped; configured existing local PostgreSQL port 5433 unreachable. HTTP/RLS/actual transaction isolation checks are unverified, not passed. No DB reset/drop, migration, provision, configuration or resource change.
- `npm.cmd run lint`: exit 0; two warnings in unchanged test/sales-conflict.e2e-spec.ts (unused resB and array sort compare).
- `npx.cmd tsc --noEmit -p tsconfig.build.json`: exit 0.
- `npm.cmd run build`: exit 0.
- `git diff --check`: exit 0.
- Additional `npx.cmd tsc --noEmit -p tsconfig.json`: exit 1 from errors outside FO1 surfaces (legacy missing Account.memberId test fixtures, supertest/types import and business-registration transaction spy typing). No errors reported in new overview files. This extra check does not replace required build typecheck.
- Fixtures are unique-tenant, targeted cleanup only, and do not call email services. The existing test configuration verifies localhost and exact bazar_test database before application startup; no environment values or secrets disclosed.
- Rollback boundary: overview module/controller/DTO/service/tests/docs plus AppModule import and one impersonation route entry; existing reports and previous finance fact services remain unchanged.
- Initial status was partial because required E2E was unavailable; the verified continuation below resolves that blocker. Commit/risk/review boundary and authored count remain parent-owned and pending.

## FO1 authorized verification continuation

- User explicitly authorized starting only the existing local postgres-test container after opening Docker. `docker compose start postgres-test`: exit 0. Bounded `docker compose exec -T postgres-test pg_isready`: accepting connections, exit 0. No creation/recreation, other service, configuration change, migration or provisioning.
- First reachable E2E run: 269 passed / 1 failed. The new fixture incorrectly used category merchandise for an inventory purchase; existing DTO and database require inventory. Corrected only that fixture category and normalized the touched test file. No production behavior change was needed.
- `npm.cmd run test:e2e -- test/finance-overview.e2e-spec.ts test/impersonation-matrix.e2e-spec.ts`: exit 0, 270 passed in 2 files (8 overview, 262 impersonation). This now verifies HTTP guards, boundary/separation/reversal arithmetic, tenant isolation, and actual RepeatableRead/RLS/same-transaction identity.
- PostgreSQL driver emitted an existing concurrent-query deprecation warning during the combined run; no test failure.
- Status: FO1 writer implementation/required verification complete; checkbox stays pending parent commit/review accounting. Existing local postgres-test remains running, as explicitly authorized. Unique-context fixtures cleaned themselves up; no reset/drop or email calls.
- Post-fixture-fix checks rerun: focused DTO/service tests 17 passed (exit 0); npm.cmd run lint exit 0 with same two unchanged warnings; npx.cmd tsc --noEmit -p tsconfig.build.json exit 0; npm.cmd run build exit 0; git diff --check exit 0.

## FR1 writer evidence (pending parent closure)

- Route: delegated direct, schema/audit/isolation design and multiple nontrivial files. User exception-ok remains in force; no artificial 400-line truncation. No commits, native review, remote operations or memory writes performed by the writer. Parent FO1 closure and its exact reviewed boundary are preserved; FR1 checkbox stays pending.
- Added FinanceReserve and FinanceReserveReversal with UUIDv7 identities, period DATEs, MXN positive amount constraints, immutable stored fingerprint/receipt audit fields, unique one-cancellation-per-reserve relation, composite tenant-aware RESTRICT account/member/device/reference foreign keys, ENABLE/FORCE deny-by-default RLS and both tenant extension delegates.
- Implemented socio-only POST/GET reserves, active account/member/device SHARE-lock reauthorization, tenant identity advisory locking, normalized immutable receipt replay (201 first / 200 exact same account), own-context payload/account 409, inaccessible global UUID collision generic 404, strict exact-period/status list and context/filter-bound receivedAt/id cursor. Fingerprints/storage receipts omitted from lists. Currency defaults MXN; required occurredAt is audit-only. Cancellation HTTP remains FR2, not claimed complete.
- Overview now subtracts active EXACT_PERIOD reserve sums inside its existing RepeatableRead tenant snapshot, preserving negatives, cost coverage, non-cash/non-withdrawable flags, separate expense/contribution/shift totals and all existing report behavior. Removed temporary RESERVES_PENDING warning; docs explicitly mark cancellation endpoint/concurrency pending.
- RED observed before implementation: required focused unit command exit 1 (2 failed / 40 passed across 42 tests against reserve DTO placeholder); isolated finance-reserves HTTP command exit 1 (expected create 201, observed missing-route 404). Subsequent implementation caught normalized timestamp expectation and corrected the new test, without weakening the contract.
- `npm.cmd run prisma:generate`: exit 0; regenerated only src/generated/prisma (ignored generated outputs).
- Local-safety review verified scripts/test-environment.ts requires localhost and exact bazar_test, checks development/test DB separation, and verifies migrator/runtime same host+database. scripts/migrate-test.mjs uses migrate deploy; provisioning chained by the authorized command targets only the restricted test runtime role. No reset/drop, config change, container change or other resource provisioning.
- `npm.cmd run db:migrate:test`: exit 0; applied only new additive 20261007120000_finance_reserves to existing localhost bazar_test, creating two tables/indexes/constraints/RLS. Standard chained script updated existing test runtime-role attributes and configured password, renewed DML/schema/default grants, and revoked migration-table access. No environment values, passwords or raw URLs disclosed; no development database migration.
- Final normalized `npm.cmd test -- src/finance/finance-reserve.dto.spec.ts src/finance/finance-overview.dto.spec.ts src/finance/finance-overview.service.spec.ts`: exit 0, 44 passed in 3 files (25 reserve DTO, 7 overview DTO, 12 overview service).
- Final `npm.cmd run test:e2e -- test/finance-reserves.e2e-spec.ts test/finance-overview.e2e-spec.ts test/impersonation-matrix.e2e-spec.ts`: exit 0, 312 passed in 3 files (30 reserves, 8 overview, 274 impersonation). Covers normalized replay after fixture cancellation, conflicts/account binding, rejected client scope, permissions, exact/mismatched periods, active/reversed list, cursor tenant/filter binding, negative overview, raw RLS deny-by-default and all composite audit edges plus cross-tenant reversal reference. Fixtures use unique contexts/targeted cleanup and no email calls.
- `npm.cmd run lint`: exit 0; only two unchanged sales-conflict warnings (unused resB and sort compare). Combined E2E emits existing pg concurrent-query deprecation warning, non-failing.
- `npx.cmd tsc --noEmit -p tsconfig.build.json`: exit 0. `npm.cmd run build`: exit 0. `git diff --check`: exit 0.
- Normalized only changed finance sources/tests/docs and touched declaration ranges in tenant.extension.ts/impersonation-matrix; no repository-wide formatting. Prisma schema keeps existing formatting plus additive models.
- Rollback boundary: FR1 API/module integration, reserve schema/migration/RLS/delegates, overview reserve deduction and associated tests/docs; keep FO1 overview/report semantics. Applied local additive schema must be treated as an applied migration, not edited/reapplied during rollback. Parent owns commit/review and running authored-line accounting.
- Status: FR1 writer scope complete with observed required checks. FR2 remains pending; browser queue/local pending/offline snapshots, cash/commitment/capital/compensation/distribution reconciliation remain out of scope. Engram mirror is still pending parent session registration.
