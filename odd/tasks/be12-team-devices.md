# BE-12 — Team management and device management with one-time activation

Branch: `feat/backend-e0-be12-team-devices` (from `feat/backend-e0-be11-multitenancy` @ `dbfacee`).
Status: in progress. No push until the user says so.

## Objective

Close the known blocker: an approved business has exactly one socio and one device, with no way to add more.
Deliver (1) team management (socios/colaboradores) and (2) device management with a one-time activation code.

## Approved decisions (from the request)

- Role `socio` = full access: may add socios or colaboradores inside its own `contextId`.
- `POST /members` (socio only): `nombre`, `apellidos`, `correo` (required, `@IsEmail`), `role`, optional `commissionRateBps` (rejected for a socio). Creates Member + Account in one transaction, emails a random temporary password (reuse `generateTemporaryPassword`, Resend fallback to `APPROVAL_NOTIFICATION_EMAIL`), records `createdByMemberId`.
- `POST /auth/change-password` for any authenticated Member: `{ currentPassword, newPassword }`, verifies the current one, Argon2id.
- `POST /devices` (socio only): `name`, optional `correoEnvio`; generates a one-time `identifier` (UUIDv7), device `status = pendiente_activacion`.
- `POST /devices/identify`: activates a pending device (identifier + name match) and returns `{ deviceId, deviceToken }` once; the token is a long random secret stored hashed; the identifier is burned.
- `PATCH /devices/:id/revoke`, `PATCH /devices/:id/reissue`, `GET /devices` (socio only; no identifier/token once consumed).
- Colaborador on any management endpoint -> 403.

## Decisions taken while mapping (the request left them open)

1. **Account <-> Member link (user chose "Account.memberId + guard").** `Account` today is one shared login per business with no Member link, so a colaborador account could send a socio's `x-member-id` and pass `SocioGuard`. New nullable, unique `Account.memberId`. When set, `ContextGuard` requires `x-member-id` to equal it. When null (the shared login of every existing business, including the founding account created by business approval) behavior is unchanged: the shared-tablet flow where several people pick their name keeps working. Accounts created by `POST /members` are always bound.
2. **Legacy devices (ContextGuard migration).** `x-device-id` is the internal `Device.id` and carries no secret today. New nullable `Device.tokenHash`. `tokenHash IS NULL` = legacy device: keeps working with `x-device-id` alone (all seeded devices, all e2e fixtures, every device already stored in a frontend, and the initial device created by business approval). `tokenHash` set = the request must also send `x-device-token`, compared through its sha256 hash. A socio moves a legacy device to the token model by `reissue`. The legacy path has an explicit sunset to be scheduled once the frontend sends the token.
3. **Status vs `authorized`.** New enum `DeviceStatus { pendiente_activacion, activo, revocado }` with default `activo`. The existing `authorized` boolean stays the operating gate read by the guard and the four services; management code keeps it in sync (`activo` = true, otherwise false).
4. **Burned identifier -> 409 Conflict** with a clear message, distinct from wrong credentials (403).
5. **`/devices/identify` keeps requiring the JWT** (needs the tenant context for RLS).
6. **New header `x-device-token`** must be added to the CORS allow-list and its spec.
7. **`correo` of a new member is used only to send the credentials; it is not persisted** (Member has no such column and the request did not ask for one).
8. **The initial device of a business approval stays legacy** (`activo`, no token) so onboarding through today's frontend keeps working.
9. **Frontend follow-up (out of scope):** a device activated through the new flow gets a token the current frontend ignores, so it would receive 403. The frontend must send `x-device-token` before real use of `POST /devices`. Documented in both api-contract copies.

## Delivery constraints

- One atomic Conventional Commit per task, tests and docs alongside. No push.
- TDD mode ON. Source: explicit user request. Runner: `npx vitest run <file>` (unit), `npm run test:e2e` (e2e, needs the `postgres-test` container on 5433; run `npm run db:migrate:test` after each migration).
- Do NOT run `nest build` (it rewrites `dist/`, which the running dev server executes) and do NOT migrate the dev database: use `npx tsc --noEmit -p tsconfig.build.json` for type checks. The dev DB migration and API restart happen after review.
- `.env*` files are permission-denied for the tools; never edit them.
- Planning heuristic of ~400 authored changed lines per task is advisory only.

## Tasks

Route per task: delegated direct writer (one writer at a time). Trigger evidence: each task touches 2+ non-trivial files.

- [x] **T1 Schema and migrations.** `Account.memberId`, `Member.createdByMemberId`, `DeviceStatus`, `Device.status/tokenHash/activatedAt/revokedAt`; data migration for existing devices; regenerate client; seed and existing tests still green.
- [x] **T2 Shared helpers.** Extract the duplicated Argon2id hashing into one helper; add the device secret helper (random secret + sha256 hash + constant-time compare).
- [x] **T3 ContextGuard.** Member binding through `Account.memberId`; `x-device-token` verification with the legacy path; CORS allow-list update.
- [ ] **T4 Device management.** `POST /devices`, `GET /devices`, `identify` activation, `revoke`, `reissue`; activation email.
- [ ] **T5 Team management.** `POST /members` (transactional Member + Account, `createdByMemberId`), credentials email with the Resend fallback generalized.
- [ ] **T6 Change password.** `POST /auth/change-password`.
- [ ] **T7 Documentation.** `doc/reglas-de-negocio.md`, `doc/api-contract-for-frontend.md` in both repos, swagger examples, README, this file.

## Acceptance

Each endpoint in the request is covered by tests including the 403 for a colaborador; a revoked token fails on the very next request; a reissued identifier works and the old token stops working; the full unit and e2e suites are green; lint is clean apart from the two known warnings in `test/sales-conflict.e2e-spec.ts`.

## Progress and evidence

- **T1 (this commit).** Migration `20260925120000_be12_team_devices`, applied to the TEST database only (`npm run db:migrate:test`); the dev database is NOT migrated yet.
  - Columns: `Account.memberId` (unique, FK `ON DELETE RESTRICT`), `Member.createdByMemberId` (indexed self-FK, `ON DELETE SET NULL`), `DeviceStatus` enum, `Device.status` (default `activo`), `tokenHash`, `activatedAt`, `revokedAt`. `authorized` and `Device_identifier_key` untouched; no RLS change needed.
  - Backfill: unauthorized devices -> `revocado` + `revokedAt`; authorized devices stay `activo`; no token invented. The `UPDATE` runs between `NO FORCE` / `FORCE ROW LEVEL SECURITY` on `Device` so it is not a silent no-op when the migration owner is not a superuser.
  - RESTRICT vs SET NULL: RESTRICT on `Account.memberId` because SET NULL would silently turn a bound colaborador login into an unbound shared one that may pick any Member; SET NULL on `createdByMemberId` because it is attribution only.
  - Not enforced by the schema: an `Account` and its `Member` sharing the same `contextId` (Member has no `unique(id, contextId)`); T5 must create both inside the same tenant transaction.
  - RED -> GREEN: `test/be12-schema.e2e-spec.ts` 14 failed / 2 passed before the migration; 16/16 after. The backfill test runs the exact SQL from the migration (marker comments) as the runtime role under RLS.
  - Full suite after T1: unit 18 files / 250 tests; e2e 19 files / 170 tests; `npm run lint` only the 2 known warnings; `npx tsc --noEmit -p tsconfig.build.json` clean; `prisma migrate diff` test DB vs schema: no difference.
  - `src/generated/prisma` is gitignored, so the regenerated client is local only (`npm run prisma:generate`) and is not part of the commit.
- **T2 (this commit).** `src/common/password.ts` (`hashPassword`, `verifyPassword`) is now the single place that picks Argon2id and its parameters (library defaults, unchanged); `auth.service.ts`, `prisma/seed-data.ts` and `business-registration.service.ts` use it. `src/common/device-secret.ts` (`generateDeviceToken`, `hashDeviceToken`, `verifyDeviceToken`) is self-contained: 32 random bytes in base64url, sha256 hex, constant-time compare that never throws.
  - Deliberate behavior: `argon2.verify` throws a `TypeError` on a malformed hash (`garbage`, empty, truncated). `verifyPassword` returns `false` instead, so a corrupt stored hash fails closed as a 401 rather than a 500. Hashing parameters and the login timing behavior (always verify, dummy hash for an unknown user) are unchanged.
  - RED -> GREEN: the two new specs failed on the missing modules, then 29/29 passed. `generateTemporaryPassword` stays in `initial-credentials.ts`.
- **T3 (this commit).** `AuthGuard` now loads `Account.memberId` onto `request.account`. `ContextGuard` refuses (same generic 403, `Selection is not authorized for this context`) when the login is bound to a Member and `x-member-id` is a different one, and when the selected device has a `tokenHash` but the request carries no matching single `x-device-token` (checked with `verifyDeviceToken`). A device with no `tokenHash` is LEGACY and keeps working with `x-device-id` alone; the shared login (no bound Member) keeps choosing any Member of its context. `x-device-token` is allowed by CORS and described in the Swagger header docs.
  - Every reader of `x-member-id` was checked. Covered: `ContextGuard` (the binding); `isRequestingSocio` in `src/auth/socio-check.util.ts`, which now takes the account's bound Member and refuses any other candidate, and its two callers `MembersService.list` (`GET /members?includeInactive=true`) and `ProductsService.list` (`GET /products?includeInactive=true`), fed from their controllers with `request.account.memberId`. Left as they are on purpose, because they only run after `ContextGuard` and read `request.selection.memberId`, which is already bound: `SocioGuard`, and the members, products, sales and deudas services (`sales.service.ts` also compares the body `memberId` against that selection).
  - The four services that re-check the device inside their transactions (members, products, sales, deudas) still require `authorized: true`; no token logic was added there, the guard owns it.
  - A repeated `x-device-token` header reaches Node as one comma-joined string, never as an array, so it simply fails the hash comparison (403). The test pins it.
  - RED -> GREEN: `test/context-guard-binding.e2e-spec.ts` 10 failed / 9 passed before the guard change (the 9 are positive controls: legacy device, shared login, right token), 19/19 after; `src/http/cors.spec.ts` 1 failed before, 32/32 after.

## Review notes

- **T1 (commit `c7e3979`): native review approved and the receipt is burned.** Three non-blocking advisories, recorded here and NOT to be re-reviewed:
  - (a) The backfill test runs the `UPDATE` as the runtime role, not the `NO FORCE` / `FORCE ROW LEVEL SECURITY` lift as the migration owner, so the cross-tenant path of the migration is not proved by a test.
  - (b) `authorized = false` -> `revocado` is a deliberate fail-closed assumption: such a device could not operate before either, and a socio can reissue it.
  - (c) `status` and `authorized` can drift (no CHECK constraint): T4 must pin the allowed pairs with tests.
- **T2 (commit `0ba1564`): native review approved (four lenses) and the receipt is burned.** Its six non-blocking advisories (a silent catch-all in `verifyPassword`, a `storedHash: string` signature that did not match the runtime null handling, a redundant hash length check, a pinned library version in a comment, and no test proving the malformed-hash 401 at login) are addressed in the commit `fix(auth): log unexpected password verification failures`.
- **T3 (commits `51e314b` + `bc703d6`): native review approved (four lenses) and the receipt is burned.** Five non-blocking advisories, all addressed in `refactor(auth): make the member binding explicit in isRequestingSocio`:
  - (two advisories, one issue) `isRequestingSocio` took an optional `accountMemberId` tested by truthiness while `ContextGuard` tested `!== null`: the parameter is now required (`string | null`) and both enforcement points share one predicate, `isBoundToMember` (`!= null`).
  - The impostor `PATCH /members` test only checked for a 403: it now asserts the generic guard message and that the member was not renamed.
  - The e2e probe cast `deviceToken` to `string` without saying why: a comment explains the deliberate array-at-runtime cast used by the repeated-header test.
  - Every `TypeError` from `argon2.verify` is treated as a malformed hash and stays silent: documented as a known limit in `verifyPassword`.

## Engram mirror

Pending: `mem_save` fails with `ambiguous_project` (the working directory holds two repos) and the user has not chosen a project. Local file is the record until then.

## Next step

T4 (device management).
