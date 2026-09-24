# BE-02–BE-09 reality verification

## Objective and authority
Verify the existing backend for real on `feat/backend-e0-be09-deudas`, fix observed failures, reconcile documentation and environment, and commit only corrections. No push, history rewrite, reset, or development data deletion.

## Tasks
- [x] VERIFY-1: Run Docker, installation, generation and development migrations; capture first results.
- [x] VERIFY-2: Correct failures and pass build, lint, unit and isolated integration tests.
- [x] VERIFY-3: Compare business rules, document actual modules and environment, verify API docs access locally.
- [x] VERIFY-4: Persist complete evidence, read back mirror and create scoped correction commits without push.

## Verification policy
Existing TDD policy: off BE02–04, on from BE05; this task is verification/correction, first observed failures precede fixes. Exact runners: `npm.cmd run build`, `npm.cmd run lint`, `npm.cmd test`, `npm.cmd run test:e2e`. Forecast 250–450 authored lines including rewritten README and tests; delivery ask-on-risk. Commit scope limited to post-verification corrections, pending final count.

## First-run evidence (2026-09-23)
- Clean branch confirmed. Docker `compose up -d` and `compose ps`: dev/test healthy, separate localhost ports 5432/5433 and volumes.
- `npm.cmd install`: ETARGET @nestjs/swagger@^12.1.0 nonexistent. Registry later confirms 12.0.2 compatible with Nest12; express-basic-auth1.2.1 bundles types; @types/express-basic-auth E404.
- `npx.cmd prisma generate`: passed (7.10.0).
- `npx.cmd prisma migrate dev`: passed, applied sales_conflict_status/incidencias/commissions/deudas migrations without reset.
- Build: 27 errors; missing Swagger/basic-auth packages across controllers/DTOs/docs; sales.service.ts invalid PrismaClientKnownRequestError named export causing downstream narrowing errors.
- Lint: passed with 3 warnings (unused resB in two conflict suites, missing sort comparator).
- Unit: 4 files, 36 tests passed.
- E2E: 10 suite import failures for missing Swagger; database.e2e-spec.ts failed because test database lacks Member.commissionRateBps migration.

## Progress / next step
All functional checks passed after corrections. Five scoped code/test correction commits created; this report and README are delivered in the following documentation commit. No push authorized.

## Corrections and root causes
- Dependencies: pinned @nestjs/swagger12.0.2 (registry peer Nest12/TypeScript6 compatible); removed nonexistent @types/express-basic-auth because express-basic-auth1.2.1 includes declarations. npm install then succeeded; Dinero2.0.2 required no change.
- Prisma: imported Prisma.PrismaClientKnownRequestError; recognized actual adapter-pg nested Sale_pkey metadata, not only meta.target. All failures existed on clean starting revision ae958ad; no baseline failure was hidden.
- E2E second run exposed a real same-ID500 and Incidencia foreign-key cleanup failure. Fixed cleanup only within fixture context. Stock-race tests had relied on scheduler timing; a barrier now makes both real transactions observe stock before row locks.
- Further RED test: identical sale requests consuming the final unit produced201/500. Re-reading persisted identity after stock failure and handling rejected-insert uniqueness returns201/200, one sale, no false incident (GREEN6/6 focused).
- Authorized schema addition: nullable Sale.requestFingerprint, SHA256 normalized headers/items; rejected requests now compare attempted items. Additive migration 20260924002500_sale_request_fingerprint applied to both databases, no reset/history removal. New rejection exact replay200/changed items409 and historical null fingerprint409 tested. Fingerprint-specific test was added after implementation; no RED-first evidence is claimed for that correction (process limitation).
- API documentation: actual HTTP test first found raw /docs-json or /docs-yaml200 without credentials. Protected both beside /docs; all now tested404 disabled,401 missing/wrong and200 correct. App listens on loopback ephemeral ports and closes in afterEach.
- Business money rule: replaced raw paidMinor + montoMinor with Dinero addition; split-payment settlement2000+4000=6000 verified.
- Blank PRODUCT_UPLOAD_DIR from the example resolved to repository root; fallback now treats blank as absent, regression test verifies uploads/products.

## Final verification (2026-09-23)
- docker compose up -d / compose ps: PASS, both PostgreSQL16 services healthy.
- docker volume ls --filter name=bazar-api_postgres: postgres_dev and postgres_test distinct named volumes.
- compose exec -T postgres psql -U bazar_dev -d bazar_dev -c '\dt' and corresponding postgres-test/bazar_test: 13 tables each, including all BE02–09 entities and migration history.
- npm.cmd install: PASS, 11 packages added. npx.cmd prisma validate and generate: PASS7.10.0.
- npx.cmd prisma migrate dev: PASS; applied existing BE05–09 then additive fingerprint migration. npm.cmd run db:migrate:test: PASS9 migrations present.
- npm.cmd run build: PASS. npm.cmd run lint: PASS, two existing nonblocking warnings (unused resB and missing sort comparator in sales-conflict.e2e-spec.ts).
- npm.cmd test: PASS5 files/37 tests. npm.cmd run test:e2e: PASS12 files/90 tests.
- node .tmp/be09-isolation.mjs: PASS90 e2e tests again, separate bazar_dev/bazar_test identities; isolated test marker absent from dev; SHA256 digest of every development table's sorted row JSON identical before/after marker and full suite. No development fixture writes.
- node .tmp/be03-seed-smoke.mjs: PASS actual Prisma db seed CLI twice, exactly1Account/2Member/3Device, temporary isolated context cleaned.
- Temporary JWT_SECRET then node .tmp/verify-lifecycle.mjs: compiled Nest app connected to bazar_dev, HTTP root200, app.close invoked Prisma disconnect. No secret printed/persisted.
- npm.cmd run test:e2e -- test/docs.e2e-spec.ts: included in final suite; real HTTP enabled/disabled/auth matrix passed, servers closed.
- git diff --check: PASS. No push/merge/main/history rewrite.

## Documentation and environment reconciliation
- doc/reglas-de-negocio.md exists; no path substitution needed. Compared modules/controllers/services/DTOs/tests with its product, money, context, sale, incident, commission, report and debt rules.
- README was stale BE04-only and claimed no sales/commissions/payments. Completely rewritten for actual BE02–09 routes, permissions, setup, seed, database isolation, all variables and limitations.
- Inspected every process.env occurrence under source, scripts and seed (including destructuring). .env.example already covered all operator variables; added internal NODE_ENV explanation. No new real secrets.
- Documented changed-payload conflict correction and conservative legacy behavior in business reference. Sequential already-empty-stock400 remains explicit implementation limitation, not falsely described as complete offline reconciliation.
- Documented public images, shared-tablet non-personal selection, no cross-page snapshot, no offline client, no payouts/cancellations, partial OpenAPI property annotations, fixedUTC-06 historical-timezone limitation.

## Advisory / remaining limitations
- npm reported9 vulnerability advisories (6high/1moderate/2low) and blocked install scripts for Prisma engines, Prisma, argon2, esbuild, @scarf/scarf. Runtime checks succeeded; no force-upgrade or install-script policy bypass.
- Vite warns its tsconfigPaths support can replace the existing plugin; no unrelated dependency modernization performed.
- Initial shell inherited NODE_TLS_REJECT_UNAUTHORIZED=0; subsequent package/check commands explicitly set1 for that process. Global environment was not changed.
- Legacy rejected sales cannot recover missing attempted items; returns409. No historical fingerprint backfill fabricated.
- Passing tests are bounded evidence, not exhaustive proof of every concurrency or production deployment case. TDD history before this task is not reconstructed; fingerprint-specific RED missing is disclosed above.

## Delivery and rollback
Parent explicitly authorized scoped correction commits, no push. Units: dependencies; fixture isolation; docs auth; money/storage; sale identity migration/runtime; README/report. README replacement alone499 authored lines is retained as one coherent requested rewrite rather than artificially split/minified. Generated lockfile excluded from authored forecast. Reverting a schema-dependent runtime unit requires compatible code deployment; do not drop fingerprint data or delete database volumes. Runtime-only units can be reverted independently with their tests. Code/test commits: 09e7c88 dependencies; af03aea deterministic fixture isolation; 6b5e095 documentation auth; d53a152 money/storage; 8479a70 sale identity migration/runtime. Documentation commit is the commit containing this report (resolve with git log -1 -- odd/tasks/backend-e0-be09-verification.md).

