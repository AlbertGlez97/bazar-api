# BE-02: Reproducible PostgreSQL persistence

Prepare Docker-backed development and isolated integration databases, a Prisma schema and migration, and the NestJS database lifecycle. This proves persistence infrastructure without implementing business behavior.

## Scope and constraints

- Authorized: PostgreSQL 16 Compose services, named volumes, environment examples, compatible Prisma dependencies/client/schema/migration, NestJS database module, infrastructure checks and operating instructions.
- Required entities: `Member`, `Device`, `Product`, `Sale`, `SaleItem`; `Product.tipo` enum `unica | cantidad`; creation timestamps; unique client-generated sale UUID.
- Additional authorized scope: Dinero v2 MXN helpers, arithmetic examples, and monetary DTO validation/tests. Excluded: authentication, additional endpoints, product operations, sale orchestration, stock mutation, idempotency algorithms and frontend work.
- Preserve existing user-owned files. No remote operations, push or PR is authorized.
- TDD: **off** for BE-02, BE-03 and BE-04 by the user's explicit instruction on 2026-09-22; **on** from BE-05 onward. This feature covers BE-02 only. Implement first, then verify acceptance.
- Runner: Vitest; `npm test` (`vitest run`) and `npm run test:e2e` (`vitest run --config ./vitest.config.e2e.ts`). On this Windows shell invoke `npm.cmd` / `npx.cmd` because PowerShell blocks their `.ps1` shims.

## Work unit

- [ ] **BE02-1** Deliver and verify persistence infrastructure as one coherent unit.
  - [x] Configure separate local PostgreSQL 16 services with distinct credentials, database names, published localhost ports and named volumes.
  - [x] Add non-sensitive `.env.example`; load development and test URLs explicitly.
  - [x] Install compatible Prisma packages, generate the client, and model the five required entities with approved Int cents.
  - [x] Add `PrismaService` initialization/destruction and import `DatabaseModule` into `AppModule`.
  - [x] Route both Vitest configurations to a fail-closed test environment before application imports; never fall back to the development URL. Apply migrations to test through the same guarded path.
  - [x] Generate the initial migration against development, verify the five tables, and exercise the backend lifecycle against PostgreSQL.
  - [x] Verify tests, build, lint, schema and database separation; document exact commands and observed results below.
  - [ ] Close with an explicit-path Conventional Commit on a feature branch after resolving the unborn-repository baseline; record its identity below.

- [ ] **BE02-2** Close the verified dinero.js v2 MXN helpers and monetary DTO work unit. Implementation and tests are complete; commit pending parent delivery/baseline decision.

## Acceptance and proposed checks

| Check | Proposed exact command / evidence | Status |
| --- | --- | --- |
| Compose starts | `docker compose up -d`; `docker compose ps` | Passed; both healthy, PostgreSQL 16.15 |
| Schema valid | `npx.cmd prisma validate` | Passed |
| Initial development migration | `npx.cmd prisma migrate dev --name init` | Passed; `20260923023515_init` applied to bazar_dev |
| Client generation | `npx.cmd prisma generate` | Passed; Prisma 7.10.0 |
| Development tables | `docker compose exec -T postgres psql -U bazar_dev -d bazar_dev -c '\dt'` | Five required tables plus migration table |
| Test tables | `docker compose exec -T postgres-test psql -U bazar_test -d bazar_test -c '\dt'` | Same six tables, separate owner |
| Isolated test migration | `npm.cmd run db:migrate:test` | Passed; migration applied to bazar_test, repeat reports no pending migrations |
| Unit tests and isolation guards | `npm.cmd test` | Passed: 30 tests, 3 files |
| PostgreSQL integration and HTTP smoke | `npm.cmd run test:e2e` | Passed: 2 tests, 2 files |
| Compile / lint | `npm.cmd run build`; `npm.cmd run lint` | Both passed |
| Process startup | `npm.cmd start` | Successful Nest startup; stopped only the launched process |
| Lifecycle harness | `node .tmp/verify-lifecycle.mjs` | Development SQL connected, HTTP Hello World, app.close invoked Prisma disconnect |
| Separation harness | `node .tmp/verify-isolation.mjs` | bazar_dev vs bazar_test, test marker count 1; all five development table snapshots unchanged, test marker removed |

Commands using `docker` require its local executable directory in the process PATH. Do not change global PATH or PowerShell execution policy. Source-mutating formatters run before final checks. Never reset or delete development data for verification.

## Decisions and blocking gaps

- Verified baseline: Prisma/client/pg adapter 7.10.0 with ESM-generated client; Dinero.js 2.0.2 includes MXN from `dinero.js/currencies`. Registry engine metadata supports Node 24; installation/build/tests passed on Node 24.16.0/npm 11.13.0. The obsolete separate currencies package was removed. Prisma latest tag pointed to an 8 RC, so the stable 7 series was explicitly pinned.
- **Money approved:** Prisma Int cents for all monetary fields with Minor suffix. Use dinero.js v2 with MXN, never raw Number arithmetic for money or Prisma Decimal. Add money conversion/formatting helpers and integer/nonnegative monetary DTO validation without endpoints.
- Optional photo representation and authenticated account relationships are not needed to prove BE-02 infrastructure; defer rather than invent their contracts. Business-policy gaps do not authorize BE-03 or later work.
- Git is an unborn `master`; every initial project file is untracked. No baseline commit exists. Do not blanket-stage or claim a meaningful base diff; parent must resolve safe baseline capture before the required implementation commit.
- Native RDD status is unknown: parent observed `gentle-ai` 1.36.0 rejecting the review command. Do not enable, upgrade or fabricate review approval. Keep actual functional verification and independent checking under the parent gate.

## Delivery and rollback

- `delivery_strategy`: `ask-on-risk`; no chain strategy selected.
- Forecast: approximately 500-650 authored changed lines excluding generated client, migration and lockfile. This is provisional; the untracked scaffold cannot be counted as authored BE-02 changes. The per-task 400-line guideline is advisory, not permission to omit tests or compress code.
- Resolve delivery strategy before a commit if the real feature forecast or authored running count exceeds 400 lines.
- Proposed slices: infrastructure and money contracts; parent delivery choice pending. Branch: `feat/backend-e0-be02`. Approximately 580 authored changed lines including this tracker, excluding generated migration/client/lockfile; exact counts provided at handoff. Commits: none; reviewed boundary unavailable (unborn repository). Original-file snapshots in ignored `.tmp/be02-before` allow comparison without treating initial scaffold as authored work.
- Rollback boundary: newly introduced Compose/Prisma/database/test-isolation files plus the exact package, AppModule, test configuration and documentation edits. Preserve original scaffold and named database volumes; volume deletion is not an automatic rollback.

## Progress and next step

Implementation and required checks completed on 2026-09-22; no commit, push or PR created. Docker operations used `& "$env:LOCALAPPDATA/Programs/DockerDesktop/resources/bin/docker.exe"` followed by the exact Compose arguments above. `docker inspect bazar-api-postgres-1 bazar-api-postgres-test-1 --format '{{.Name}} {{range .Mounts}}{{.Name}} {{end}}'` confirmed separate `bazar-api_postgres_dev` and `bazar-api_postgres_test` volumes. Local ignored `.env` was initialized from the non-sensitive example for verification.

Additional diagnostics / limitations:
- `npx.cmd tsc --noEmit` fails at the pre-existing `test/app.e2e-spec.ts` import `supertest/types` (TS2307). Required Nest build and lint pass; original test was not changed.
- `npm.cmd audit --json`: 9 advisories (6 high, 1 moderate, 2 low). `npm.cmd audit --omit=dev --json`: 4 high paths through Prisma, @prisma/config, deepmerge-ts and mysql2. Do not claim production audit clean. Existing Nest tooling also has tmp/undici advisories; no force upgrade performed. Audit evidence lives in ignored `.tmp/be02-audit*.json`.
- Initial formatter invocation included `.env.example`, for which Prettier has no parser. Final supported-file normalization succeeded; `.env.example` remains plain dotenv text. Original README content was retained byte-for-byte after the new introduction.
- npm reported Prisma install scripts blocked by its existing policy; explicit validate/generate/migrate succeeded without changing that policy.
- The runtime initially had TLS verification disabled in its environment. Package operations explicitly set `NODE_TLS_REJECT_UNAUTHORIZED=1` in their own process; no global policy was changed.
- RDD unavailable as described above; independent verifier and parent delivery/baseline decision remain pending. Optional photo/account representation remains deferred; no endpoints or auth were added.

Next: parent independent verification and dependency-risk/delivery decisions, then explicit-path work-unit commit(s). Mirror topic: `odd/backend-e0-be02/tasks`; repository locator: `odd/tasks/backend-e0-be02.md`.
