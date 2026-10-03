# Finance contributions

## Objective and authorized scope

Record money a Member delivers to the business, independently of sales, profit, ownership, compensation and automatic capital recovery. Implement only Contributions in bazar-api and bazar-frontend. No expenses, shifts, distributions, reserves, loans, capital recovery or sales changes. No merge, push, remote operations, production Docker or deploy.

## Architecture and acceptance

- Explicit tenant-scoped immutable Contribution; integer MXN cents; client UUID v7; contributor distinct from authenticated recording Member and Device.
- Socio-only administration using existing guards. New contributors must be active socios in the same context; historical records remain readable and replayable after contributor deactivation.
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
- [x] FC2 — Backend auditable reversal and atomic replacement, concurrency/idempotency tests/docs.
- [x] FC3 — Frontend durable scoped financial persistence and synchronization with backwards-compatible IndexedDB upgrade and tests.
- [x] FC4 — Responsive contributions management UI, existing components, filters, create/reverse/correct and tests/docs.
- [x] FC5 — Full relevant verification, independent audit, parent spot check, fix confirmed in-scope defects and record final limitations.

## Required checks

- API: `npm.cmd run lint`; `npx.cmd tsc --noEmit -p tsconfig.build.json`; `npm.cmd test`; `npm.cmd run test:e2e`; `npm.cmd run build`; `git diff --check`.
- Frontend: `npm.cmd run lint`; `npx.cmd vue-tsc -b`; `npm.cmd run test:run`; `npm.cmd run build`; `git diff --check`.
- Run focused tests first. Read existing test setup and use only isolated test databases; never reset dev/production data, read secrets into output or send real emails.
- Record exact command/results including environmental failures; no claim of success for unavailable checks. All source-mutating normalization precedes final verification.

## Progress and recovery

All five tasks completed and verified, including the independently validated recovery correction. Tracking was created before source edits. Engram mirror: odd/finance-contributions/tasks (bazar-api), locator bazar-api/odd/tasks/finance-contributions.md. Preserve this document and commit/evidence on recovery. Next: user review; no further finance scope, integration or remote delivery is authorized.

### FC1 evidence

- DTO RED: 6 passed / 1 failed (sub-millisecond timestamp accepted); GREEN: 7/7 after restricting persisted instants to millisecond precision. Initial HTTP attempt was environmental, not RED: test DB unavailable, 13 skipped.
- Authorized isolated postgres-test service started; only local bazar_test migrated. SQL BOM caused first migration failure before any statement; removed BOM and marked that test-only attempt rolled back, then deploy/provision succeeded. No dev/production database changed.
- HTTP harness: npm.cmd run test:e2e -- test/contributions.e2e-spec.ts: 13/13 passed.
- Rollback boundary: finance creation/list module, Contribution table, tenancy registration, new tests/docs; no sales changes. Full suite checks follow FC2.
- Engram mirror readback remains unavailable due outer-workspace ambiguity; preserve local tracker.

### FC2 evidence

- FC1 commit: 6589c6e; slice backend-create/list: 704 additions + 1 deletion, coherent >400-line local boundary; future PR needs honest re-slicing or maintainer size exception, no PR authorized/created.
- Behavioral RED: focused HTTP suite 13 passed / 7 failed (reversal endpoint absent); GREEN after reversal implementation and list projection: 20/20. Additional cross-tenant UUID collision RED:20 passed/1 failed (500 instead409), GREEN:21/21.
- Atomic original/reversal/replacement preserved; concurrency identical replay and distinct reversal one-winner, rollback of invalid/used replacement, raw RLS isolation exercised. Creation receipts remain unchanged after reversal.
- Full HTTP suite initially589 passed/2 failed because new protected routes needed registration in existing self-checking impersonation matrix; updated matrix, then609/609 in28 files. No bypass of guard tests.
- npm.cmd test:405/405 in28 files; focused DTO7/7. npm.cmd run lint: exit0, two existing warnings in test/sales-conflict.e2e-spec.ts (unused resB and sort compare). Typecheck/build/diff-check:exit0.
- Runtime harness uses only local postgres-test / bazar_test; both migrations applied there. No dev/production migration, no real email (existing suites mock delivery). No credentials printed.
- Rollback boundary: remove reversal endpoint/service methods/table/relationships/new tests and matrix entries, retaining FC1; migrations are additive, reversal references restrict physical deletion.
- Next: durable origin-scoped frontend queue and Finance > Contributions UI. No expenses/work shifts/distributions/recovery/reserves implemented.

- FC2 commit:0257a00; slice backend-corrections:500 additions +27 deletions. Running backend authored change count:1232 (705+527). Cohesive units kept intact; no PR branches created. Focused security matrix after removing unrelated formatter changes:216/216.

### FC3 evidence

- Frontend commit762901f (448 additions+6 deletions before readability normalization). Separate durable financial operations/history/references and IndexedDBv2 additive upgrade preserve legacy sales/debt/catalog stores.
- Behavioral RED database upgrade:2 failures (v1 insteadv2), GREEN2/2; sync RED4 failures/4 passing with stub engine, GREEN14/14; existing localdb10/10.
- Focused foreground26/26, lint/typecheck/build/diffcheck exit0. Build retains existing toast dynamic/static import and large-chunk warnings. No dependency installation.
- Original/confirmation identity, shared account attribution, different Account/API/device, pending reversal dependencies, paused/review/transient errors, uncertain ack/storage failure, cross-tab lock exclusion and immutable histories covered.
- Rollback boundary: added finance stores/sync/types/store/shell lifecycle and selective Workbox exclusion; keep existing IndexedDB stores/operations. Native risk independent parent verification still pending. No browser visual verification claimed.
- NextFC4 finance management route/form/list/corrections and full suite.

### FC4 evidence

- Frontend commit d92e8a8: 2055 additions +243 deletions, including readability normalization of FC3 files, scoped reference fetch/Workbox exclusion, responsive UI, route/menu guards, store/readback proof and tests/docs. Running frontend commit churn:2752 (454+2298); this includes formatting and is not net feature line count. Coherent local boundaries exceed the advisory heuristic; future PRs require honest re-slicing or maintainer exception. No PR authorized or created.
- UI behavioral RED: placeholder yielded3 failed/1 passed; GREEN4/4, expanded8/8 plus route/menu2/2. Durable readback RED2 failed/1 passed (scope reset erased committed pending display); GREEN3/3 after committed scope establishment. A failed initial durable write still rejects without false pending/success.
- Foreground focused224/224 in10 files (new UI/sync/upgrade plus navigation/router), additional store3/3. Frozen late correction acknowledgement preserves a later reversal of its replacement.
- First default full suite3205 passed/8 failed:6 newly outdated menu expectations corrected,2 lazy-import5000ms timeouts. Focused router tests passed with bounded workers and unchanged timeout configuration. Final npm.cmd run test:run -- --maxWorkers=2:3216/3216 in184 files,199.97s, exit0. This resource-bounded rerun is the full-suite proof; the initial failure is not hidden or claimed baseline.
- Final npm.cmd run lint, npx.cmd vue-tsc -b, npm.cmd run build, git diff --check and staged diff-check:exit0 after normalization. Build retains toast dynamic/static import and >500kB chunk warnings; test harness emits existing missing-stub-route warnings plus new Finanzas links in old harnesses, no failed tests.
- UI uses existing AppButton/Input/Select/Textarea/Modal/Card/Badge, date/money utilities; socio-only Gestion > Finanzas > Aportaciones, member/period filtering, durable create, pending/confirmed correction/annulment, no other financial domains or sales totals. Date-only means fixed UTC-6 economic midnight; inclusive end UI translates exclusive next day.
- Offline references only actual successful /members?includeInactive=true responses, scoped account/API; no generic financial HTTP cache. No reference snapshot means honest unavailability. Local lists are partial last-known snapshots, not complete ledger totals. Pending conflicts remain visible and are never silently deleted; retry does not mutate UUID/payload.
- No browser visual verification claimed: responsive CSS and component proof only. Frontend native RDD state unknown; parent independent verifier and spot check pending. Backend source unchanged in frontend iteration. Engram full mirror write backed by explicit project, readback unavailable due outer workspace ambiguity; preserve canonical local tracker.
- NextFC5: independent frontend audit and final parent validation. No push, merge, deploy, remote work or production Docker.

### FC5 bounded correction evidence (independently validated)

- Independent frontend verification reproduced a recovery dead end: original401 pauses creation, dependent correction moves to needs_review, recovering and confirming original did not expose a UI retry action for the reviewed correction. Parent authorized one bounded in-scope fix; no additional finance behavior.
- Frontend commit471844d: explicit correction retry available for both paused and needs_review, pending remains non-retryable. No automatic business-conflict loop; immutable operation origin and payload unchanged. Also corrected stale IndexedDB headerv1 to v2 and documented recovery. Five files,136 additions+2 deletions; rollback removes only retry eligibility/regression docs/tests/header correction.
- Behavioral RED targeted UI/sync:26 passed/1 failed (needs_review button absent). GREEN44/44 in6 files, including paused/review/pending UI eligibility and complete401 dependency recovery/manual retry success plus genuine409 remaining review without silent deletion or automatic resend. Runtime harness: real sync engine and fake-indexeddb durable operations with controlled network responses.
- Final normalized foreground checks: npm.cmd run lint exit0 with no warnings; npx.cmd vue-tsc -b exit0; focused contribution suite44/44; npm.cmd run test:run -- --maxWorkers=2 3221/3221 in184 files,192.70s; npm.cmd run build exit0; git diff --check and staged diff-check exit0. Build retains existing toast dynamic/static import and chunk-size warnings. An earlier full run also3221/3221; final rerun followed removal of formatter-only noise so exact final source bytes are covered.
- Backend source untouched. At writer handoff FC5 was pending parent validation; final evidence below records its completion. No push, merge, PR, deploy, remote or production Docker. Engram full mirror refreshed after local tracker commit; readback remains unavailable due outer-workspace ambiguity.

### Final independent verification and delivery state

- Independent backend verifier: contributions HTTP21/21, DTO7/7, impersonation216/216, typecheck and committed diff-check exit0. Six additional isolated HTTP/RLS/replay/concurrency harness checks passed. No significant backend defect found.
- Independent frontend verifier: initial contributions29/29 and existing integration83/83 passed; reproduced the dependency recovery issue, then independently validated the bounded fix at471844d with27/27 (sync16/UI11) and diff-check exit0. The issue is resolved; no new review cycle or scope expansion.
- Parent spot checks: backend DTO7/7; frontend IndexedDB/store5/5. Structural readback confirmed dedicated contribution endpoints/schema, socio-only Finance route and preservation of existing stores. Native risk assessment medium in both repositories; backend RDD off and frontend mode unknown, no native review started or fabricated approval.
- Final source checks of record: backend unit405/e2e609, lint/typecheck/build exit0 (two pre-existing lint warnings); frontend3221/3221 with maxWorkers2, lint/typecheck/build exit0 (existing bundle warnings). Full checks were run by the writer; independent focused checks and parent spot checks are separate evidence, not claims of independently rerun full suites.
- Current source boundaries: API6589c6e/0257a00; frontend762901f/d92e8a8/471844d. API08bb2ed/b10c62a/09096bf and this final task-document commit are documentation-only; identify this commit using git log -1 -- odd/tasks/finance-contributions.md.
- Both repositories remain on feat/finance-contributions. No push, merge, PR, deploy, production migration or production Docker. Only isolated local bazar_test received the two migrations. The local postgres-test service was started for proof; volumes were not reset/deleted.
- Limitations: no visual browser, real multi-tab browser or installed service-worker test; source/component/fake-indexeddb/Web Lock simulations only. Offline history is partial last-known data, and initial offline capture requires a genuine cached socio list. Operations cannot be reassigned to another account/API/device. Future PR boundaries still require re-slicing or an approved size exception; no PR created.
- All five tasks completed with actual checks. Next: user reviews the contributions vertical; any deployment, main integration, PR or additional finance domain requires separate authorization. Engram full mirror saved; full mirror readback remains unavailable due outer workspace project ambiguity, with the local canonical document preserved.
