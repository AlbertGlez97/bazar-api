# BE-11 reality verification (multi-tenancy, RLS, business registration)

Execute for the first time everything BE-11 introduced (new `resend` dependency, `contextId` columns, strict RLS with FORCE, business registration with email approval), fix observed failures and reconcile documentation with the verified behavior.

## Authority and boundaries

- Authorized root: `bazar-api/` on branch `feat/backend-e0-be11-multitenancy` (local and `origin/...` both at `42b02d7` when this started; the brief said it was not on origin, which was wrong).
- Allowed: `docker compose`, `npm install`, `prisma generate/migrate/seed`, build, lint, unit and e2e tests, corrections and scoped commits on this branch.
- NOT authorized: push, history rewrite, force operations, reading `.env` (a permission rule denies it; use `.env.example` for names and the container's own environment for database access).
- Real Resend flow needs a `RESEND_API_KEY` from the user and a click on the emailed link; do not invent either.
- No development data deletion without a recorded backup and a recorded reason.
- TDD: **on** (existing repo policy: on from BE-05, source `odd/tasks/backend-e0-be09-verification.md`). Verification-first: observe the failure, then fix. Runners: `npm.cmd run build`, `npm.cmd run lint`, `npm.cmd test`, `npm.cmd run test:e2e`.
- Delivery: `ask-on-risk`. Native review: RDD status must be assessed per work-unit commit; if unavailable, record it, never claim approval.

## Tasks

- [x] **T01 — Preparation.** Fetch, Docker up, `npm install` (first time with `resend`), `prisma generate`.
- [ ] **T02 — Migration and RLS (priority).** Decide recreate vs migrate-in-place; apply migrations; run seed; test `isRowLevelSecurityViolation` against the real Postgres/Prisma error; verify with direct SQL that RLS is enabled, FORCED and deny-by-default on every tenant table.
- [ ] **T03 — Code checks.** Build, lint, unit and e2e (watch `test/rls-strict.e2e-spec.ts` and the multitenancy isolation specs).
- [ ] **T04 — Corrections.** Fix real failures (RLS/seed first), document each blind assumption that was wrong, repeat T02 and T03 until clean.
- [ ] **T05 — Business registration end to end.** Real Resend email, approve link, founder Member, isolation from the original context, reject link, reused token. Blocked until the user supplies the key.
- [ ] **T06 — Documentation.** `doc/reglas-de-negocio.md`, `.env.example` and Swagger match the verified behavior.
- [ ] **T07 — Final summary.** Leave the result committed on the branch; no push.

## Acceptance and checks

- `isRowLevelSecurityViolation` proven against the real error (or corrected), with the real message and code recorded.
- Direct SQL evidence (outside Prisma) of enabled + forced + deny-by-default on all tenant tables, taking into account superuser and BYPASSRLS roles.
- Build, lint, unit and e2e pass; `git diff --check` clean; conventional commits, no AI attribution.

## Progress and evidence

- Start state: branch clean; no `node_modules`; Docker Desktop was not running (started from `AppData\Local\Programs\DockerDesktop`, daemon 29.8.0); containers `bazar-api-postgres-1` and `bazar-api-postgres-test-1` and volumes `bazar-api_postgres_dev`/`_test` exist from about 40 hours earlier, so the dev database may hold pre-multi-tenancy data.
- Already known from reading: migration `20260924080000_multitenancy_context_columns` backfills `contextId` from existing relations (exact, not a guess); a later commit `2259e5c` already made the policies strict and moved `set_config('app.context_id', ..., true)` into `seedContext`; the previous session never executed any of it.
- Hypotheses to test, not assume: (1) with Prisma 7 + `@prisma/adapter-pg` a rejected upsert may surface as unique violation `P2002` rather than SQLSTATE `42501`; (2) the container `POSTGRES_USER` is a superuser, which bypasses RLS even with FORCE.

### T01 evidence (2026-09-24)

- `git fetch origin`: `origin/feat/backend-e0-be11-multitenancy` had one extra commit, `447e2b9` (`docs(be-11): update business rules, env example and swagger`, docs only); local was its ancestor, so `git merge --ff-only` was used. The brief said the branch was not on origin; it was.
- Docker Desktop was not running (started from `AppData\Local\Programs\DockerDesktop`, engine 29.8.0); `docker compose up -d`: both Postgres 16 services healthy (5432 dev, 5433 test).
- `npm install`: `resend@4.0.1` plus 50 transitive packages added, 0 versions changed or removed. **`package-lock.json` in HEAD did not contain `resend`**, so `npm ci` would have failed on a clean checkout; the working-tree lockfile now includes it. The 5 blocked install scripts (`argon2`, prisma, esbuild, scarf) did not matter: `argon2` loads and hashes, `prisma generate` passes (7.10.0).

### T02 evidence

- Decision (recreate vs migrate): **migrate in place, no volume deletion.** The dev DB held only what the seed created (1 Account, 2 Members, 3 Devices; every other table empty, counted exactly because `pg_stat` estimates were stale). The new `contextId` columns are `NOT NULL DEFAULT 'legacy-unassigned'` and backfilled from existing relations, so they cannot conflict with old rows; migrating in place exercises the real upgrade path and keeps the earlier policy of not deleting development data. A `pg_dump` backup (20 KB) was taken to the session scratchpad first. The from-scratch path was verified separately, without touching any volume, on a temporary database inside the test container: all 13 migrations applied cleanly to an empty database.
- `npx prisma migrate dev` applied `active_flags`, `multitenancy_context_columns`, `multitenancy_rls`, `business_registration` (4 pending, 0 errors). `npx prisma db seed` passes on dev and is idempotent.
- **Root finding (design):** the role the app connects with (`bazar_dev`, the docker `POSTGRES_USER`) is `rolsuper = true` and `rolbypassrls = true`. RLS is enabled and FORCEd on the 11 tenant tables, but Postgres never applies RLS to a superuser or BYPASSRLS role, FORCE included, so **with the current connection role the database does not deny anything**; the migration comment claiming FORCE makes the policy apply to the app's own connection is only true for a non-superuser owner. The test role `bazar_test` has the same flags.
- Policies themselves are correct: on a temporary database, as a `NOSUPERUSER NOBYPASSRLS` role, no `app.context_id` gave 0 visible rows, `ctx-A` gave only A's row, the other tenant's row by id gave 0, and `pg_policies` shows the `tenant_isolation` policy on 11 tables.
- `isRowLevelSecurityViolation` vs the real error (Prisma 7.10 + adapter-pg + Postgres 16, non-superuser role): (1) a genuine RLS violation raises `PrismaClientKnownRequestError` `P2039` whose `.message` ends with ``Database error. Code: `42501`. Message: `new row violates row-level security policy for table "Member"` `` and `meta.driverAdapterError.cause.originalCode = '42501'`; it has no `.cause`. The function DOES recognize it (via `.message`); the format assumption was right. (2) The case it was written for, seeding a context whose fixed Member id or Device identifier already belongs to another context, raises **`P2002`/`23505` unique violation** (`Member_pkey`, `Device_identifier_key`), not `42501`, because RLS hides the other row from the scoped session and the INSERT then collides in the unique index. The function returns `false`, so the raw Prisma error escapes instead of `Seed member context mismatch`. The blind assumption that was wrong: "Postgres itself still refuses the write with an RLS violation". With the superuser connection the friendly error still comes from the post-check, so the bug is invisible in dev.
- Control: `set_config('app.context_id', ..., true)` inside the interactive transaction works (`current_setting` returned the context, the row created under it was visible to that session).

### T03 first-run evidence (before any fix)

- `npm run build`: FAIL, 5 TypeScript errors (`business-registration.service.ts` lines 105, 136, 201; `tenant.extension.ts` lines 145 and 159).
- `npm run lint`: exit 0, 4 warnings (2 pre-existing in `test/sales-conflict.e2e-spec.ts`, 2 new `unicorn/no-useless-fallback-in-spread` in `tenant.extension.ts`).
- `npm test`: 6 files / 39 tests pass.
- `npm run test:e2e` (after `npm run db:migrate:test`): 14 files failed / 2 passed; 4 tests failed, 6 passed, 105 skipped. Root cause of most: **infinite recursion in the `$transaction` override of `src/database/tenant.extension.ts`** (`RangeError: Maximum call stack size exceeded`, `ctx = Prisma.getExtensionContext(this)` resolves to the same override), plus `expected 200 got 500`.

### T04 corrections (2026-09-24), one delegated writer, verified independently by the parent

- Result after the fixes (parent re-ran everything): `npm run build` exit 0; `npm run lint` exit 0 (2 pre-existing BE-09 warnings in `test/sales-conflict.e2e-spec.ts`); `npm test` 8 files / 60 tests (was 6 / 39; +21 new); `npm run test:e2e` 16 files pass, 1 fails; 118 tests pass, 1 fails, 0 skipped (was 14 files failed, 105 skipped).
- Commits on the branch (not pushed): `058cc28` lockfile with `resend`; `7b009ce` registration callback typed as `string`; `45a1345` tenant `$transaction` recursion; `c46368b` seed guard; `43fa2b6` e2e fixtures.
- Recursion (`45a1345`): root cause `Prisma.getExtensionContext(this)` is the extended client, so `ctx.$transaction` re-entered the same override. The raw `$transaction` is now taken from the base client and called with the extended client as receiver, so `tx` keeps the tenant filter. A second bug surfaced while verifying: the "inside managed transaction" flag was a mutable field reset around a synchronous call, already cleared when the awaited queries ran, so every nested call opened its own transaction until the pool timed out; it now lives in its own `AsyncLocalStorage`.
- Seed guard (`c46368b`): the parent verified with a `NOSUPERUSER NOBYPASSRLS` role on a temporary database (fixed code): a conflicting context now yields `Seed member context mismatch`; seeding a clean context succeeds and is idempotent (2 Members, 3 Devices in that context only).
- Wrong blind assumptions, documented: (1) that Postgres rejects a cross-context upsert with an RLS violation (it raises a unique violation); (2) that FORCE ROW LEVEL SECURITY makes the policy apply to the app's connection (not for a superuser or BYPASSRLS role, which the docker `POSTGRES_USER` is); (3) that the managed-transaction flag could be a synchronous mutable field; (4) that `$transaction` could be overridden by calling the extended client's own method.
- Native review: each commit assesses `medium` (`executable_change` / `configuration_change`), so per the protocol it is deferred to slice close; the native counter reports about 1255 lines because it includes the generated lockfile.

### Still open (needs the user)

- The one failing e2e test is `test/rls-strict.e2e-spec.ts` "a raw query with no app.context_id set returns zero rows from any tenant-scoped table" (`expected [ Array(1) ] to have a length of +0 but got 1`): the app and test connections use a superuser with BYPASSRLS, so the database never denies anything. Options and a recommendation were put to the user (dedicated runtime role for the app, tests and seed; migrations keep the owner role; plus a startup guard that refuses a superuser or BYPASSRLS connection).
- T05 needs a `RESEND_API_KEY` from the user (and a click on the emailed link); reading `.env` is denied, so the key has to be added by the user.

## Next step

Wait for the user's decision on the runtime role; then implement it, re-verify RLS with direct SQL through the app's own role, re-run build, lint, unit and e2e, and continue with T05 and T06.
