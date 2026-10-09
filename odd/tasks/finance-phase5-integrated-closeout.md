# Phase 5 integrated closeout

## Objective and boundaries
Verify the existing pure distribution simulator through the preserved local API, frontend, Chrome and controlled records. Fix only confirmed small Phase 5 defects and add the missing real HTTP overflow-propagation test. Do not persist simulations, implement payments, start Phase 6, push, merge, rebase, squash, publicly deploy or touch Cloudflare.

## Initial Git evidence
- API: feat/finance-distribution-simulator, HEAD 38996a87c6a0f6ac679aeb728074edd776ea47f2; main merge-base f1e98a1; Phase 4 ancestor 3f81316.
- Frontend: same feature branch, HEAD ee0ce8064c05eee2faa6d0af949ab7fc81f9ae4c; main merge-base c707210; Phase 4 ancestor 6e71c77.
- API clean. Three frontend status entries have no substantive numstat difference: overview/reserves fixtures and reserve types. Preserve EOL-only state without broad normalization.

## Tasks and routing
- [x] IC1: Correct mounted-session base reload and accessible maximum hint using deterministic RED/GREEN tests. Delegated direct: preparation and multiple nontrivial Vue/test files.
- [x] IC2: Add real overview-overflow 422 propagation e2e; document member FK/RLS/snapshot invariant and existing unstructured validation hints. Delegated direct: test execution and fixture preparation.
- [x] IC3a: Rebuild current local branches, verify migrations, RLS and compiled API URL. Delegated execution; worker observed 25 migrations applied, none pending, no Phase 5 migration; FORCE RLS and restricted role retained. PostgreSQL start time/data/volumes preserved, API/frontend HTTP200. Served index-BWiEFGNi.js contains /api/v1 and no malformed MSYS prefix; parent activated PWA update.
- [x] IC3b: Controlled financial/member/work scenario and authenticated real 50/50, 70/30, 100/0, 0/100, hours, warnings and 422 cases. Parent Chrome plus delegated normal API cases.
- [x] IC4: Real responsive/keyboard, configuration staleness, ephemeral lifetime/session and Phase 1–4 navigation. Parent browser interactions.
- [x] IC5: Final full suites, checks, small commits, native assessment/review if enabled and evidence report. Delegated execution; parent owns native continuations.

Forecast: 150–300 authored source/test lines plus passive evidence documentation. Local work-unit commits only; ask-on-risk delivery strategy if forecast exceeds review-size guidance. Source edits single-threaded. Record commit identities and actual checks before closing tasks.

## Discoveries and decisions
- Mounted allowed-to-allowed session changes reset the store without triggering the existing allowed-boolean watcher: confirmed UX bug; reload valid base and clear visit-local state.
- CashInput maximum text is not associated with its actual input: compose an explicit external description ID with existing parse-error association.
- No structured 400 validation code exists; retain robust generic fallback and document supplementary regex hints. Structured 422 codes remain authoritative.
- WorkShift composite member/context FK, same-tenant RLS, inclusive worker-member query and RepeatableRead snapshot prevent the alleged missing-member state. Keep the defensive assertion, no speculative logic change.
- The October 7 Phase 4 operating result is MXN7500 but exact-period reserve MXN3000 leaves potential MXN4500. Preserve that reserve; establish a separate financial period for the requested MXN7500 base.
- Parent browser inspected Mi equipo: only Testing Cruz, active SOCIO. Normal member creation sends external credentials email; no local email stub exists. Do not create members or use ambient delivery credentials without explicit destination authorization.
- Current products require cost; partial-cost legacy scenarios require accepted automated fixtures, never lab SQL edits. Inactive/no-partners cases remain defensive/fixture evidence where no existing member makes a normal live case possible.

## Checks observed before corrections
Lab/backend worker: focused 79 unit and 331 e2e; full 577 unit/36 files and 838 e2e/33 files. Lint (two existing warnings), build-tsconfig typecheck, build and diff-check passed. Test database localhost5433/bazar_test is separate from preserved laboratory data. Required suites must be rerun after the new test/fixes.

## Recovery and next step
Phase 5 closeout is complete on the parent-reported real integration evidence and worker-attributed checks. See doc/finance-phase5-integrated-closeout.md for the final evidence matrix and accepted fixture limits. Later delivery or Phase 6 requires the user's decision. Historical pending notes below describe earlier checkpoints, not the final status.

Engram mirror pending: runtime hook has no authoritative registered session identity and forbids attributed memory tools. No identity invented or write attempted. This local document is the recovery record.

## Bounded corrections evidence
- Session attribution RED: five new regressions failed (overview requested twice instead of three times; stale form retained). GREEN: 64/64 view tests after the watcher fix. Token-only follow-up RED: one regression failed (two instead of three overview calls); GREEN: final focused 131/131 (65 view + 52 CashInput + 14 store).
- Maximum accessibility RED: two failures (missing input aria-describedby). GREEN: focused view/CashInput/distribution-store command passed 130/130 (64 + 52 + 14), including description/error composition and removal of absent help ids.
- FE commits: 6d3ea3d adds session regressions; c6e3c69 applies session correction; 014c36a binds maximum help to the input. The first pair is one rollback boundary: SimulatorView.vue and its tests. A newline-sensitive patch did not apply before the first commit; history is preserved, not rewritten. Accessibility rollback boundary: CashInput and SimulatorView descriptions plus their tests.
- API new real HTTP overflow test: npx.cmd vitest run --config ./vitest.config.e2e.ts test/finance-distribution.e2e-spec.ts passed 46/46. Coverage-only existing behavior: no meaningful production RED is expected and no backend behavior was changed. A tenant-scoped test SaleItem has quantity/unitCostMinor 2147483647: the individual PostgreSQL Int values fit, their BigInt cost product is unsafe, and the endpoint returns 422 FINANCE_OVERVIEW_OVERFLOW.
- API invariant retained: WorkShift composite member/context FK and same-tenant RLS guarantee worker membership; the inclusive member query and RepeatableRead snapshot preserve it while calculating. Retain the defensive missing-member assertion. HTTP400 has no structured code; regex validation text is supplementary only, with the generic fallback unchanged.
- Initial post-fix API full check: npm.cmd test passed 577/577; npm.cmd run test:e2e failed 6/839 (833 passed), all 5000ms timeouts in business-registration (retry after credentials email failure) and change-password (shared/bound roles, existing token, collaborator 403, password boundaries, concurrent changes). npm.cmd run lint passed with two existing sales-conflict warnings; npm.cmd run build and git diff --check passed.
- The initial FE full run and API e2e overlapped and exhausted practical timing headroom. Contention is a hypothesis, not an established root cause. One serial normal-runner rerun subsequently passed 839/839 in 33 files (53.83s), versus the initial failed 124.85s run; no timeout or runner configuration changes are authorized.
- Test database target observed: 127.0.0.1:5433/bazar_test; preserved laboratory financial data was not touched by these tests. Runtime boundary for FE corrections is deterministic mounted-view tests; parent owns real Chrome integration. API runtime boundary is the real Nest HTTP endpoint and isolated PostgreSQL fixture.

## Final bounded-writer verification
- FE final commit 2dbc2e4 covers token-only valid-session changes while mounted; RED was 1/65, GREEN 131/131 focused. npm.cmd run test:run passed 3882/3882 in 214 files (120.89s); npm.cmd run lint, npx.cmd vue-tsc --noEmit, npm.cmd run build and git diff --check all passed. Build retained existing chunk-size/dynamic-import warnings; no visual or deployment change.
- API npm.cmd test passed 577/577 in 36 files; focused real distribution HTTP suite passed 46/46; final serial npm.cmd run test:e2e passed 839/839 in 33 files. Final npm.cmd run lint passed with the same two existing sales-conflict warnings; npm.cmd run build and git diff --check passed. Initial six timeout failures remain disclosed above, not relabeled as passing. Serial success supports resource contention, not a proved root cause.
- Source freeze for bounded fixes is complete after final checks. No formatters, post-check source changes, database lab edits, remote delivery, push, merge, rebase, squash, deployment or native review were performed. Parent still owns independent verification/native assessment and IC3b/IC4/IC5 integration evidence; checked IC1/IC2 do not mean Phase 5 integration is closed.
- Auth/session and maximum-description rollback boundaries remain narrow frontend code/tests. API rollback boundary is the added overflow HTTP test and this passive evidence document; production backend logic remains unchanged.

API work-unit commit: 2d5c9ad404e68abc993c563a247e55fc04bca7dc (overflow test and closeout evidence). This identity was recorded after commit without amending history; parent may include this passive tracker update in its final evidence commit.

## Real-browser unchanged-request rejection correction
- Parent confirmed criterion 14: a successful 600000-minor simulation against cached 750000 base was retried unchanged after a normal exact-period reserve reduced the server base to 550000. The real 422 EXCEEDS_AVAILABLE error appeared, but the old result lacked a stale label. Root cause: resultIsStale compared only the request fingerprint, which does not capture changing server financial data.
- Minimal view-only correction also treats a prior result as stale while the simulation error exists. Existing previous-result display is preserved; next successful simulation clears the error/stale label; unrelated overview refresh failure does not falsely label it. No client arithmetic, store mutation logic, backend logic or financial-data change was added.
- RED: npx.cmd vitest run src/views/finance/__tests__/SimulatorView.test.ts observed 1 failed/65 passed (66 total), specifically missing stale-note after unchanged success then 422. GREEN: npx.cmd vitest run src/views/finance/__tests__/SimulatorView.test.ts src/components/ui/molecules/__tests__/CashInput.test.ts src/stores/__tests__/finance-distribution.store.test.ts passed 132/132 (66 + 52 + 14).
- Serial final npm.cmd run test:run passed 3883/3883 in 214 files (118.38s); npm.cmd run lint, npx.cmd vue-tsc --noEmit, npm.cmd run build and git diff --check passed. Existing build warnings retained. API suites were not rerun because no API/test/backend change occurred. Parent owns repeat browser acceptance/native assessment; integration is not closed by this correction.
- FE correction commit: b04fba45296156034b8c003c3aced383d0463f1a; source/test diff +27/-1 across two files. Tracker evidence remains a passive uncommitted parent-owned closeout update; no amend performed.

## Final integration closure (October 9)
- IC3b: Normal authorized second-partner creation and credentials email completed. Real API/Chrome September 28 base 750000 and request 600000 verified 50/50 totals 270000/330000; 70/30 totals 282000/318000; 100/0 totals 300000/300000; 0/100 totals 240000/360000; known minutes 120/180 totals 270000/330000. Extended-range equal 3/3 shifts and unknown-minute warnings passed. A separate no-work period verified 100/0 and 422 NO_WORK.
- IC4: Real 320/390/768/1280 layouts, keyboard/focus/maximum description, configuration/date staleness, new simulation, reload/logout/relogin and prior-phase screens passed. Mounted valid same-allowed identity is deterministic-test evidence, not a separately reproduced browser transition. Collaborators, partial costs, inactive/no-partners and three-partner rounding retain explicit accepted fixture limits.
- Both temporary exact-period reserves were normally reversed; September 28 potential 750000/reserves zero were restored. October 7 Phase 4 reserve 300000/potential 450000 were preserved. Real unchanged-request 422 after the fix showed the human error and previous-configuration label; a successful retry cleared the error/stale label.
- IC5: Workers observed final frontend 3883 tests/214 files/focused 132 and API 577 unit/839 e2e/focused 46, plus passing lint/typechecks/build/diff. Initial six existing timeout failures are disclosed; the serial unchanged-runner rerun passed. Parent spot check 132/diff passed. Parent committed-range assessments API 38996a8..2d5c9ad (69 lines) and frontend ee0ce80..b04fba4 (140 lines) were both medium/under_budget/review_due=false. No native review was granted and no approval is claimed.
- Source boundaries API 2d5c9ad/frontend b04fba4 were unchanged at the October 9 normal relogin. The report at doc/finance-phase5-integrated-closeout.md preserves attributed evidence, commit history and accepted limits. Source remains frozen; final changes are passive docs only. The explicitly authorized member credentials email was the only remote-operation exception; no push/deploy/Cloudflare operation occurred. Engram mirror remains pending; no session identity was invented.
