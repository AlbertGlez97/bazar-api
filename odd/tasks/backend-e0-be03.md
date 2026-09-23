# BE-03: Authenticated members and authorized devices

Provide login, context-scoped member selection and identification of pre-authorized devices without adding sale behavior. Preserve BE-02 persistence and integer-money contracts.

## Authorized scope

- Add member roles `socio | colaborador`, device identifier/authorization, and minimal Account credentials/context model.
- Seed Alberto and Adid as socios and known shared/backup devices idempotently. Provision an account only from explicit operator-supplied seed credentials; never ship default passwords.
- Add JWT login/guard, authenticated member listing, device identification, and reusable account/member/device context validation.
- No sale endpoints, commissions, payments, public signup, device auto-authorization or product tenant behavior.
- TDD off per explicit user policy through BE-04; ordinary verification mandatory. Runners: `npm.cmd test`, `npm.cmd run test:e2e` (Vitest).

## Tasks

- [x] **BE03-1** Implement account/member/device schema, safe migration and idempotent seed with verification.
- [x] **BE03-2** Implement JWT login, member/device endpoints and context guard with positive/negative acceptance tests.
- [ ] **BE03-3** Run all functional checks, document actual evidence and close with work-unit commit(s) after parent delivery review.

## Decisions

- Prisma 7.10.0, ESM and existing test-database guard remain unchanged.
- Context key equality is explicit; existing records receive an isolated legacy context rather than silently joining a newly seeded account. Existing devices stay unauthorized until provisioned.
- JWT: HS256, one-hour expiration, configured secret of at least 32 characters; account is reloaded for each authenticated request, so disable/context changes apply immediately.
- Passwords: Argon2id; credentials in environment only. Seed upserts must not reset an existing password or reauthorize an explicitly revoked device on rerun.
- `GET /members` and `POST /devices/identify` require JWT only (selection bootstrapping). Exported ContextGuard validates selection headers for future routes; tests mount a test-only route to demonstrate it.

## Checks and evidence

Verified on 2026-09-23:

| Command/evidence | Observed result |
| --- | --- |
| `npx.cmd prisma validate`, `npx.cmd prisma generate` | Passed; Prisma remains 7.10.0 |
| `npx.cmd prisma migrate deploy` | Applied `20260923155500_auth_context` to bazar_dev |
| `npm.cmd run db:migrate:test` | Applied same migration to bazar_test; repeated run has no pending migrations |
| `npx.cmd prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | No difference, exit 0 |
| `node .tmp/be03-seed-smoke.mjs` | Actual Prisma db seed command twice against guarded test URL: Account=1, Member=2, Device=3; fixtures removed |
| `node .tmp/be03-migration-smoke.mjs` | Initial schema plus legacy rows migrated in isolated transaction/schema; IDs preserved, identifiers backfilled, context quarantined, authorization false; rolled back |
| `npm.cmd test` | 30 passed; BE-02 money/isolation tests unchanged |
| `npm.cmd run test:e2e` | 17 passed, including 15 BE-03 acceptance scenarios and both prior smoke tests |
| `npm.cmd run build`, `npm.cmd run lint` | Passed after final normalization |
| Existing `.tmp/verify-lifecycle.mjs`, with a random process-local JWT secret | Compiled Nest starts, connects to bazar_dev, serves unchanged root and disconnects Prisma on close |

Acceptance covers idempotent seed/no password reset, cross-context seed rollback, valid/invalid/malformed login, missing/malformed/expired/wrong-audience JWT, invalid subject, both member roles, unknown/cross-context/revoked devices, missing/cross-context selection, disabled accounts and changed account context.

Initial failures resolved: test-only context probe needed explicit AuthModule/DatabaseModule imports; seed runner changed from a PATH-dependent `tsx` command to `node --import tsx`. The sandbox blocks tsx's OS user lookup; approved elevated local seed execution passed. `prisma migrate dev --create-only` refused this noninteractive runtime even with a PTY. Instead used supported `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --output prisma/migrations/20260923155500_auth_context/migration.sql`, reviewed it, added safe legacy backfill, then applied via migrate deploy. No reset or destructive recovery was used.

Installed exact versions: @nestjs/jwt 12.0.2, argon2 0.45.1, tsx 4.23.15. Argon2 hash/verify smoke passed despite npm reporting blocked optional install scripts. Existing nine npm audit advisories remain reported by install; no forced upgrades. Prior BE-02 full-project `tsc --noEmit` issue is not addressed in this scope.

Operator prerequisites remain: set a real JWT_SECRET and SEED_CONTEXT_ID/SEED_USERNAME/SEED_PASSWORD before normal startup/development seed. No development login credentials were invented; development seed has not provisioned an account. Seed CLI functionality was verified with ephemeral test credentials only. Before public deployment, configure HTTPS and rate limiting; no public signup, refresh-token or enrollment flows are claimed.

## Delivery and recovery

- `delivery_strategy`: `ask-on-risk`. Initial forecast was approximately 650 lines. Observed authored additions plus deletions: 842, including tests/docs/tracker, excluding migration/client/lockfile (the migration also contains a small hand-authored legacy backfill). Parent must resolve the >400-line delivery choice before commits; no pushes authorized.
- Branch/base: start from clean `main`, create `feat/backend-e0-be03` before source changes.
- Rollback: BE-03 modules, seed, migration/schema additions, tests/docs and package additions only; preserve BE-02 and all existing database rows. Do not reset databases or delete volumes.
- Progress: implementation and functional verification complete; documentation updated. Parent explicitly requested no commits until delivery strategy review; no commit/push created. Branch `feat/backend-e0-be03`. Next: independent parent verification and delivery choice, then work-unit commits. Mirror topic `odd/backend-e0-be03/tasks`; locator `odd/tasks/backend-e0-be03.md`.
