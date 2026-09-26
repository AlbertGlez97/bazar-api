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
- [x] **T4 Device management.** `POST /devices`, `GET /devices`, `identify` activation, `revoke`, `reissue`; activation email.
- [x] **T5 Team management.** `POST /members` (transactional Member + Account, `createdByMemberId`), credentials email with the Resend fallback generalized.
- [x] **T6 Change password.** `POST /auth/change-password`.
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
- **T4 (three commits: `61f4af7` explicit member binding, `92d7cc5` activation email + generalized Resend fallback, and this one, the device endpoints).**
  - Endpoints (`DevicesModule` / `DevicesService` / `DevicesController`; the controller moved out of `AppModule`): `POST /devices`, `GET /devices`, `POST /devices/identify` (adjusted), `PATCH /devices/:id/revoke`, `PATCH /devices/:id/reissue`. All management routes use `SocioGuard`; `identify` keeps `AuthGuard` only because it needs the tenant context and a person activating a new device is not a socio on it yet.
  - Activation is race-safe: a conditional `updateMany ... WHERE status = 'pendiente_activacion'` (the loser matches nothing and gets the 409); three concurrent calls yield exactly one 200. The token (`generateDeviceToken`) is returned only in that response; only its sha256 is stored.
  - Wording: a used identifier answers **409** `Este identificador ya fue usado. Pide a un socio que te genere uno nuevo.`; a revoked device answers 409 `Este dispositivo fue revocado. ...`; wrong name/identifier or another business identifier stays the plain **403** `Device is unknown or unauthorized`, so the three cases are distinguishable.
  - **Legacy path of `identify` is unchanged**: an `activo` device with no `tokenHash` answers `200 { deviceId }` (no token) if it is authorized, else the plain 403. The identify tests in `test/auth.e2e-spec.ts` and `test/business-registration.e2e-spec.ts` pass without a single change.
  - **Revoke keeps `tokenHash`**: nulling it would make the device look legacy and reopen the `x-device-id`-only path. Revoke is idempotent and also cancels a pending code. **Reissue** issues a new identifier, clears token and timestamps, works on active, legacy and revoked devices (this is how a legacy device moves to the token model), and leaves everything untouched if the email fails.
  - `correoEnvio` (create and reissue): the email is sent as the LAST step inside the transaction; on failure the change rolls back and the API answers 502. The identifier is NOT in the response when emailed (`deliveredTo` says whether it went to the recipient or, in Resend test mode, to the approver as a backup). Transaction timeout 15 s vs the 10 s email deadline (unit test pins the 5 s margin).
  - The identifier is listed by `GET /devices` only while `pendiente_activacion`; `legacy` = `activo` + no `tokenHash`; no token, hash or `authorized` is ever returned.
  - Advisory (c) of T1's review is pinned by tests: after every endpoint the pair is exactly (`pendiente_activacion`, false), (`activo`, true) or (`revocado`, false), and `ContextGuard` rejects any device with `authorized = false` whatever its status or token hash.
  - RED -> GREEN: `test/devices.e2e-spec.ts` 35 failed / 8 passed before the implementation (mostly 404), 43/43 after; `src/devices/devices.service.spec.ts` failed on the missing module, 2/2 after. Commit `92d7cc5`: 9 new email tests (the credentials tests are untouched and green), and a mutation check (dropping the device-name escaping made exactly the escaping test fail).
  - Full suite after T4: unit 22 files / 297 tests; e2e 21 files / 232 tests; `npm run lint` only the 2 known warnings; `npx tsc --noEmit -p tsconfig.build.json` clean.
  - Not decided by the request, left as is: a socio may revoke or reissue the very device they are using (they lose access from it until it is reactivated).
- **T5 (two commits: `11de709` the member credentials email, and this one, the endpoint).**
  - `POST /members` (`SocioGuard`; colaborador -> 403, no token -> 401). Body: `nombre`, `apellidos`, `correo` (`@IsEmail`, also normalized with `normalizeSocioEmail`; anything the credentials email could not go to is a 400), `role` (`socio` | `colaborador`), optional `commissionRateBps` (0..10000; any value, `null` included, is a 400 for a socio; omitted or `null` for a colaborador keeps the global rate). Ids, context, username and password can never come from the body (`forbidNonWhitelisted`).
  - One transaction under the tenant context: re-validate the acting socio (`authorize`, which now returns the Member row), derive the username (`deriveUniqueUsername`: the normalized correo when free, else `<slug of the person name>-<6 hex>`), create the `Member` (`createdByMemberId` = the acting socio) and its `Account` (same `contextId`, `memberId` = the new Member, so that login can only act as them; this is how the same-context invariant left open by T1 is kept), and send the email as the LAST step.
  - **The correo is not persisted** (no column holds it; the username derived from it is the only trace).
  - **502 rollback policy**, same as the business approval: an email failure or an expired transaction (15 s vs the 10 s email deadline; a unit test pins the 5 s margin) rolls everything back and answers 502 with a clear Spanish message, never the password. A lost username race (unique violation on `Account_username_key`) is retried up to 3 times with a fresh derivation, then answered 409.
  - **`credentialsEmail` in the 201**: `member` (the person's own address) or `approver-fallback` (Resend test mode forwarded the credentials to the approver as `[RESPALDO]`), so the frontend can confirm visually where they went. The response also carries `id`, `name`, `role`, `active`, `commissionRateBps`, `createdByMemberId` and `username`; never the password or its hash. `GET /members` is unchanged.
  - RED -> GREEN: `test/members-create.e2e-spec.ts` 42 failed (all 404) before the endpoint, 42/42 after; `src/members/members.service.spec.ts` (transaction timeout relation and the failure handling: race retry and 409, 502 on expiry, no retry on other errors) 8/8; commit `11de709`: 13 new email tests failed on the missing method, 63/63 after.
  - Mutation check: dropping `memberId` from the `Account` insert made exactly the 3 tests that depend on the binding fail (the created row, and both end-to-end impersonation tests); reverted.
  - Full suite after T5: unit 23 files / 318 tests; e2e 22 files / 274 tests; `npm run lint` only the 2 known warnings; `npx tsc --noEmit -p tsconfig.build.json` clean.
- **T6 (two commits: `3f4c768` test hardening for the shared email deadline, and this one, the endpoint).**
  - `POST /auth/change-password` (`AuthGuard` ONLY: a socio, a colaborador and the shared login can all use it, and it works right after a first login with a temporary password because no member/device selection is read). Body `{ currentPassword, newPassword }` (`whitelist` + `forbidNonWhitelisted`): both strings; `currentPassword` 1..128; `newPassword` 10..128 and different from `currentPassword` (custom `DiffersFrom` validator whose message names the fields, never the values). Passwords are never trimmed. It changes the Account of the JWT (`request.account.id`); an account id can never come from the body.
  - Success: 204 with an empty body; the stored value is a fresh argon2id hash (`hashPassword`).
  - **403, not 401, for a wrong current password** (`Current password is incorrect`): the frontend's Axios interceptor treats every 401 as an expired session and logs the person out, which would be wrong for a typo. A malformed stored hash behaves the same (403, never a 500), through `verifyPassword`. 401 stays for a missing/invalid token and for a deactivated account.
  - **Concurrency**: the write is `updateMany({ where: { id, passwordHash: <the verified hash>, active: true } })` (the `active: true` part was added by the follow-up commit `fix(auth): close the deactivation race ...`). Two simultaneous changes cannot both win, and the account keeps exactly one of the two new passwords. The loser gets **409** (`The password was changed by another request; try again with the latest password`) when both requests verified the same old hash before either wrote, or **403** when it only read the account after the winner had written (its old current password no longer matches the new hash). Both are correct and retryable; an account deactivated between the read and the write gets the same 401 as an inactive one. Mutation check: an unconditional update makes the e2e concurrency test and the unit test fail; reverted.
  - **Known follow-up (not implemented): existing JWTs stay valid until they expire (12 h, stateless) after a password change.** A `passwordChangedAt` claim check in `AuthGuard` would be the fix. Pinned by an e2e test so it is a decision, not an accident. There is also no rate limit on wrong current passwords (a stolen token could be used to guess the password); the whole API has no rate limiting today.
  - RED -> GREEN: the DTO spec failed on the missing module, 8 service tests failed on the missing method and the new e2e file was fully red before the implementation; after it `src/auth/dto/change-password.dto.spec.ts` + `src/auth/auth.service.spec.ts` 33/33 and `test/change-password.e2e-spec.ts` 27/27. (One e2e fixture bug found on the way: `Account.memberId` is UNIQUE, so every bound test account needs its own Member.)
  - Full suite after T6: unit 24 files / 349 tests; e2e 23 files / 301 tests; `npm run lint` only the 2 known warnings; `npx tsc --noEmit -p tsconfig.build.json` clean.
  - Swagger: `changePassword` added to `src/docs/operation-examples.ts` (T7 writes the prose docs).

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

- **T4 (commits `61f4af7`, `92d7cc5`, `942d5ba`): the native review was offered and the user declined it for this candidate.** Nothing was reviewed natively; the functional checks above are the only proof.
- **T5 (commits `11de709` + `0631ca3`): native review approved (one lens) and the receipt is burned.** Two non-blocking advisories:
  - `R3-shared-deadline-test-weak`: the test that claimed to prove a shared deadline never entered the fallback path. Addressed in `test(email): prove the shared deadline also covers the backup send`: the member-credentials email now has cases for a refusal followed by a backup that never settles (it ends exactly at the original deadline, not at refusal time plus another deadline) and for a refusal arriving after the deadline (no backup is sent). Mutation check: removing the `deadlinePassed` guard makes exactly the two "already passed" tests fail (the existing business-credentials one and the new member one); reverted.
  - `R3-email-before-commit` (decision, no code change): the credentials email is sent from inside the transaction as its LAST step, the same policy as the business approval. If the commit fails after a successful send, or Resend delivers after the timeout, the person may hold credentials for an Account that was rolled back. That is harmless (those credentials cannot log in) and a retry issues a fresh set. Accepted limitation; revisit if an outbox is ever introduced.
- **T6 (commits `3f4c768` + `4080648`): native review approved (four lenses) and the receipt is burned.** Six non-blocking advisories, recorded here and NOT to be re-reviewed. Four are addressed in `fix(auth): close the deactivation race and make the password-change concurrency test deterministic`; two are documented follow-ups that stay open:
  - (follow-up, open) `R1-password-change-keeps-sessions`: existing JWTs stay valid up to 12 h after a password change and wrong current-password attempts are not rate limited, so a stolen token is not ended by the victim changing the password and could be used to guess it. Both are already documented above and pinned by an e2e test; the fixes are a `passwordChangedAt` claim check in `AuthGuard` and API-wide rate limiting.
  - (fixed) `R2-concurrency-contract-overstated` + `R3-concurrency-e2e-nondeterministic`: the JSDoc, these notes and the e2e test claimed the loser of a simultaneous change always gets 409, but it can also get 403. The e2e now asserts the invariant (exactly one 204, the loser is refused with 409 or 403, the account ends with exactly the winner's password) and the 409 path is pinned deterministically in `auth.service.spec.ts`.
  - (fixed) `R2-swagger-length-literals` + `R2-swagger-description-literal-limits`: the Swagger schema and description now build the limits from `MIN_NEW_PASSWORD_LENGTH` / `MAX_PASSWORD_LENGTH` and name all three callers (socio, colaborador and the shared business login).
  - (fixed) `R3-deactivation-race-not-guarded`: the conditional write now also requires `active: true`; when it matches no row the account is read again and a deactivation answers 401 (like an inactive account) while a lost race answers 409. RED first: 3 unit tests failed before the change (the write filter, the re-read, the 401 on deactivation), 15/15 after.

## Engram mirror

Pending: `mem_save` fails with `ambiguous_project` (the working directory holds two repos) and the user has not chosen a project. Local file is the record until then.

## Next step

T7 (documentation in both repos).
