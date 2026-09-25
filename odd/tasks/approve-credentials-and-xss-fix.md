# Approve creates Account + Device, and close the stored XSS

## Objective

Fix two blocking defects found while writing `doc/api-contract-for-frontend.md`:

1. `GET /business-registration/approve` creates the founding socio `Member` but no `Account` (login credentials) and no `Device`, yet the page says the business is "ready to log in". A newly approved business cannot enter the system.
2. `renderStatusPage` interpolates `nombreNegocio` (public form input) unescaped into HTML: stored XSS in the approver's browser.

## Ground truth (verified in code)

- `Account { id, username @unique, passwordHash, contextId, active }` is a real entity, has no RLS policy (login needs it before a context is known; see the RLS migration comment), and has no email field. Passwords are Argon2id (`AuthService.login`, `prisma/seed-data.ts`).
- `Device { id, name, identifier @unique default uuid(), contextId, authorized default false }` has RLS (`tenant_isolation`); the seed creates authorized devices with an explicit identifier inside a transaction that sets `app.context_id`.
- `approve` already runs in one `$transaction` that sets `app.context_id`, creates the Member and marks the request `aprobado`.
- `contactoSocio` is free text (email OR phone; `CreateBusinessRegistrationDto` says so on purpose). The premise "send a second email to contactoSocio" therefore does not always hold.
- `EmailService` already has an `escapeHtml` for the approval email; `renderStatusPage` has none.
- The frontend has no device-identifier handling yet (no views built), and an unknown device is never auto-registered (403), so the initial device identifier must reach the user.

## Design decisions

- **Credential delivery: temporary password by email** (not a one-time set-password link). A link needs a new table/columns, a new public endpoint and a frontend page that does not exist; that is over-engineering for now. Mitigations: password is `crypto.randomBytes`-based (not derived from any input), stored only as Argon2id; the email tells the user to change it once a change-password flow exists (none today: recorded as a known gap).
- **Username**: derived from the request, unique globally (`Account.username` is `@unique`): use `contactoSocio` normalized (trim, lower-case) when it looks like an email; otherwise a generated unique slug of the business name plus a short random suffix. Never the socio's name alone.
- **Recipient**: `contactoSocio` when it looks like an email; otherwise the approver's `APPROVAL_NOTIFICATION_EMAIL` with a note to relay the credentials, so approval never silently loses them.
- **Device**: one `Device` "Dispositivo principal", `authorized: true`, explicit random identifier; the identifier goes in the same email (the client needs it for `POST /devices/identify`).
- **Atomicity**: Account + Device + Member + status update in the same transaction; the credentials email is the LAST step inside it. If sending fails, the transaction rolls back, the request stays `pendiente` (the approver can retry the same link) and the page explains it (HTTP 502). Trade-off accepted: in the rare case where the email is sent and the commit then fails, the user gets credentials that never became valid; the retry sends a new valid set.
- **Approve page text** becomes truthful: credentials were sent by email; never prints the password.
- **XSS**: escape every user-derived value in HTML pages with one shared `escapeHtml` util (reuse the email's, moved to a common place); title and message both escaped at the render boundary so no caller can forget.

## Authority and boundaries

- Root: `bazar-api/`, branch `feat/backend-e0-be11-multitenancy`. Also allowed: overwrite `bazar-frontend/doc/api-contract-for-frontend.md` with the updated document (parent does that).
- TDD **on** (explicit, plus project policy "on from BE-05"). Runners: `npm.cmd run build`, `npm.cmd run lint`, `npm.cmd test`, `npm.cmd run test:e2e` (Vitest). Observed RED before each implementation.
- No push. Never read `.env`. Real Resend must not be called in tests (mock/spy `EmailService`).
- Commits: Conventional, no AI attribution lines.
- Delivery: ask-on-risk; forecast ~500-800 authored lines including tests and docs. Advisory only.

## Tasks

- [x] **T1 — XSS RED→GREEN.** Test registers `nombreNegocio` with `<script>alert(1)</script>`, approves and rejects, asserts the HTML has it escaped; also asserts the approval email escapes (confirm with a test, not memory). Commit `fix(business-registration): escape user data in status pages` = `73c7411`.
- [x] **T2 — Approve creates Account + Device (RED→GREEN).** e2e: approve, then log in with the emailed credentials, then `POST /devices/identify` with the emailed identifier succeeds; email-failure case rolls back and stays `pendiente`; non-email `contactoSocio` goes to the approver. Commit `feat(business-registration): create account and device on approval` = `3399370`.
- [x] **T3 — Docs.** Update `doc/api-contract-for-frontend.md` (approve behavior, page text, XSS resolved, move B.4 items 1-2 to resolved, keep the rest), `doc/reglas-de-negocio.md` (full approval flow), then copy to `bazar-frontend/doc/` (the copy is done by the parent, not the writer). Commit `docs: document approval credentials flow and close known issues` = `e8c4573`. Also updated the Swagger approve example in `src/docs/operation-examples.ts`, which still said "ready to log in".
- [x] **T4 — Full verification** (writer run, after T3): `npm.cmd run build` exit 0; `npm.cmd run lint` exit 0 (2 pre-existing warnings in `test/sales-conflict.e2e-spec.ts`, identical on the base commit); `npm.cmd test` 14 files / 126 tests passed (baseline before this work: 11 / 88); `npm.cmd run test:e2e` 18 files / 138 tests passed (baseline: 18 / 127).

- [x] **T5 — 502 retry page for approve timeout and username race (follow-up finding from the native review).** Two rolled-back failures of the approve transaction surfaced as a JSON 500: the interactive transaction expiring under a pending Resend call, and P2002 on `Account.username` when two different approvals race. Both now return the same 502 HTML retry page (same page family, per-case text); the Resend credentials call has an explicit 8 s timeout (< 15 s transaction). One commit `fix(business-registration): answer 502 retry page on approve timeout and username race` (hash: the commit that adds this T5 entry; see `git log -1 -- odd/tasks/approve-credentials-and-xss-fix.md`, a commit cannot contain its own hash).

## Route declaration

Delegated direct: one writer for T1-T3 (reads 6+ files and writes 2+ non-trivial files; mapping, writer and preparation triggers all fire). Parent: frontend copy, spot check, review assessment.

## Progress and evidence

Route executed: delegated direct, one writer (T1-T3, then T4 run). TDD on; RED observed before each implementation.

### T1 (commit 73c7411)
- RED (unit) `src/business-registration/status-page.html.spec.ts`: `AssertionError: expected '<!doctype html>...' not to contain '<script>'` (page rendered `<title><img src=x onerror=alert(1)></title>` and `<p>"<script>alert(1)</script>" & 'co'</p>`).
- RED (e2e) `test/business-registration.e2e-spec.ts`, "stored XSS in the status pages", 3 failed: approve and reject pages `expected '<!doctype html>...' not to contain '<script>'`; quotes/ampersand case `expected ... not to contain '<img'`.
- GREEN: `renderStatusPage` escapes title and message with the shared `src/common/escape-html.ts` (moved out of `email.service.ts`, behavior unchanged; callers pass raw text, nothing is double-escaped). Unit 94 passed; business-registration e2e 12 passed.
- Email escaping: characterization test `escapes user-supplied text in the approval email HTML` in `src/email/email.service.spec.ts` asserts the Resend payload HTML has no raw `<script>`, `<img` or `<b>`. It PASSED on its first run (the email already escaped): it pins existing behavior, it is not a RED test. The approve/reject hrefs are server-built and remain unescaped as before.

### T2 (commit 3399370)
- RED (unit): `initial-credentials.spec.ts` `Cannot find module './initial-credentials.js'`; `email.service.spec.ts` 6 x `TypeError: (intermediate value).sendBusinessCredentialsEmail is not a function`; `business-registration.service.spec.ts` `TypeError: Cannot read properties of undefined (reading 'timeout')` (approve opened the transaction with no options).
- RED (e2e, 6 failed): login test `AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times` (today approve creates no Account, so no credentials exist and nobody can log in); failure test `Error: expected 502 "Bad Gateway", got 200 "OK"`; approver-relay test `TypeError: Cannot read properties of undefined (reading '0')` (no credentials call); collision, twice and concurrent tests fail on `expected "vi.fn()" to be called 1 times, but got 0 times` / `expected [] to have a length of 1 but got +0`.
- GREEN: unit 126 passed; business-registration e2e 19 passed. Mutation check: removing the `claimed.count === 0` guard makes the concurrency test fail (`expected [] to have a length of 1 but got +0`), so it does exercise the claim (guard restored).
- Transaction options: `PrismaService.$transaction` is the tenant-extension override (`src/database/tenant.extension.ts`), which forwards `args[1]` untouched to Prisma's real `$transaction`. Proven by `test/tenant-extension.e2e-spec.ts` "honors the transaction options" (`timeout: 200` on a 0.8 s query rejects, `timeout: 5000` resolves); it passed on first run (characterization, not RED). `approve` uses `{ maxWait: 5000, timeout: 15000 }`, asserted by a unit test.
- Cleanup check: a temporary spec (deleted, never committed) run after the full e2e found 0 leftover Accounts (`@example.com`, `solo-telefono-*`, `colision-*`). It also found 8 BusinessRegistrationRequest rows whose names lack the per-run suffix (`Bonsáis del Alberto`, `Bolsas de Adid`, `Artículos Varios`, `Negocio Expirado`), left by an older version of these specs; not created by this work, not touched.

### T3 (commit e8c4573)
- `doc/api-contract-for-frontend.md` and `doc/reglas-de-negocio.md` updated (Spanish). JSON-block parse and anchor-link check (`check-doc.mjs`, kept in the session scratchpad outside the repo): 36 JSON blocks, 58 anchors, 98 links, 0 problems (base: 36/56/90, 0 problems). `.env.example` and README unchanged: no new env var, README does not describe this flow.

### Design details settled by the writer
- Username: normalized `contactoSocio` (trim, lower-case) when it is a plain single email (`/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i`, max 254) AND <= 100 chars (login limit) AND free (`account.findUnique` inside the transaction); otherwise `<business-slug<=30>-<6 hex from randomBytes(3)>`, up to 5 attempts, then throws. The unique constraint still has the last word on a race.
- Password: `randomBytes(18).toString('base64url')` = 24 chars, 144 bits; Argon2id with `{ type: argon2id }` (same as AuthService/seed); never logged or rendered.
- Device: name `Dispositivo principal`, identifier `randomUUID()`, authorized true.
- Recipient logic lives in `EmailService.sendBusinessCredentialsEmail`: `socioEmail` present -> socio; absent -> `APPROVAL_NOTIFICATION_EMAIL` with a relay note and a different subject; missing env -> throws before calling Resend. Consequence: the e2e (EmailService fully mocked) asserts the service passes no `socioEmail` for a non-email contact; the real `to` address is asserted in `email.service.spec.ts`.
- Beyond the brief: the request is CLAIMED first with `updateMany({ where: { id, status: 'pendiente' } })`; a concurrent second approval waits on the row lock, matches 0 rows and renders "Ya fue procesado", so credentials are never created or emailed twice (before, two racing opens would create two Members; with Accounts they would also send two emails).
- Email failure: `CredentialsEmailError` thrown inside the transaction, caught in `approve`, logged (message only) and rendered as HTTP 502 with the retry text; the transaction rolls back.
- Swagger approve description/examples updated too (they claimed "ready to log in").

### T5 (single follow-up commit)
- Real error shapes (captured with a throwaway spec, deleted, against the real test DB): duplicate username inside the transaction = `PrismaClientKnownRequestError` P2002, `meta.modelName 'Account'`, `meta.driverAdapterError.cause = { originalCode '23505', kind 'UniqueConstraintViolation', constraint { index 'Account_username_key' }, table 'Account' }`; expired transaction = P2028, `meta { operation 'commit' | 'query', timeout, timeTaken }`, message "A commit|query cannot be executed on an expired transaction". The "could not start in time" P2028 carries `meta.maxWait` and is deliberately not matched.
- Resend SDK 4.0.1: `emails.send(payload, options)` only accepts `{ query }` (no signal / timeout), so `withTimeout` (`Promise.race` + timer always cleared, late rejection swallowed) bounds the credentials call at `CREDENTIALS_EMAIL_TIMEOUT_MS = 8000`. Message: `Resend credentials email timed out after 8000 ms`, wrapped by the existing `CredentialsEmailError` path. The HTTP request may still complete (documented trade-off). The approval-notification email is left untouched (no timeout: adding one would change its behavior).
- RED (unit): `approve-failures.spec.ts` and `with-timeout.spec.ts` `Cannot find module`; `business-registration.service.spec.ts` 2 x `PrismaClientKnownRequestError` rethrown by `approve` (no 502) and `TypeError: Cannot read properties of undefined (reading 'timeout')` (constant not exported); `email.service.spec.ts` `expected +0 to be 1` (no timer: the call had no timeout). 4 failed tests + 2 failed suites.
- RED (e2e, real DB, 2 failed / 19 passed): transaction expiry test `status 500, body {"statusCode":500,"message":"Internal server error"}: expected 500 to be 502` (server log: P2028 "A commit cannot be executed on an expired transaction ... timeout 1000 ms, however 1570 ms passed"); username race test `status 500, body {"statusCode":500,"message":"Internal server error"}: expected 500 to be 502` (server log: P2002 `Account_username_key` from `tx.account.create()`).
- GREEN: unit 16 files / 159 tests; business-registration e2e 21 passed (also 3 consecutive runs, all green: no flakiness in the race test); full e2e 18 files / 140 tests.
- Test seams: (a) expiry: `vi.spyOn(prisma, '$transaction')` forwards to the real implementation with `timeout: 1000` for that one request (production options untouched) while the mocked email resolves after 1.5 s; either the in-callback query or the commit then raises P2028. (b) race: a REAL interleaving, no internals mocked: approval A inserts its Account and holds its uncommitted transaction inside the mocked credentials email; approval B pre-checks (sees nothing committed), picks the same address and blocks on the unique index; the test polls `pg_stat_activity` (`wait_event_type = 'Lock'`, INSERT INTO ... Account) and only then releases A, so B deterministically fails with P2002. Then B's retry succeeds with a fresh username and both logins work.
- The 8 s < 15 s relation is asserted in `business-registration.service.spec.ts` (strictly less, with at least a 5 s margin for the queries and Argon2 before the email). `APPROVE_TRANSACTION_OPTIONS` is now exported for that.
- Docs updated where they state the approve failure behavior: `doc/api-contract-for-frontend.md` (rule 6 and the status table gain the two new 502 rows), `doc/reglas-de-negocio.md` (atomicity and failure policy), Swagger approve description/example in `src/docs/operation-examples.ts`. JSON-block and anchor check (`check-doc.mjs`, session scratchpad): 36 JSON blocks, 58 anchors, 98 links, 0 problems (same as before).
- Runners: `npm.cmd run build` exit 0; `npm.cmd run lint` exit 0 (same 2 pre-existing warnings in `test/sales-conflict.e2e-spec.ts`); `npm.cmd test` 16 files / 159 tests passed; `npm.cmd run test:e2e` 18 files / 140 tests passed.

### Not verified / limits
- Real Resend was never called (EmailService/Resend mocked everywhere); no live-server run of the new approve flow.
- The e2e cannot see Member/Device rows of a rolled-back context (RLS hides them without the context id), so rollback is proven through the Account (no RLS) plus the request staying `pendiente` with `createdContextId` null, all in one transaction.

## Next step

Parent: copy the updated contract doc to `bazar-frontend/doc/` again (T5 changed it), native review assessment of the T5 commit, then the push decision.

Memory mirror: `odd/approve-credentials-and-xss-fix/tasks`; repository locator: `odd/tasks/approve-credentials-and-xss-fix.md`.
