# Finance overview and planned reserves

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

- [ ] FO1: Recorded overview with economic periods, cost coverage, financial/nonmonetary totals, permissions, coherent transaction snapshot and tests/docs.
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

FO1 required checks now pass after authorized startup of the existing isolated local postgres-test service. Parent readback/spot check, work-unit commit and native risk assessment remain pending. FR1/FR2 remain unimplemented. Mirror remains pending until runtime registration is resolved.

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
