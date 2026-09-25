# Resend test-mode fallback and frontend follow-up fixes

## Objective

Fix the findings of the last full end-to-end verification (registration -> approval -> login), quickly, and leave both dev servers running for the user's manual testing. No push until the user confirms.

## Verified findings behind this work

- Resend is in sandbox mode: it only delivers to the owner address. Real log line: `Resend rejected the credentials email: validation_error: You can only send testing emails to your own email address (albert.gonzalez0297@gmail.com). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.` The approve then answers 502, and the retry can never succeed for that recipient.
- A newly approved business has exactly 1 Member and 1 Device; no `POST /members` or `POST /devices` exists. The device identifier is not bound to a browser (same identifier + name works from any profile): it is a shared secret of the business.
- Frontend gaps: no control to reactivate a product (the deactivate dialog promises it; `includeInactive` exists in the store but no UI sets it), no catalog link in the sidebar (a test asserts only the home item), saving an edit with no changes sends `PATCH {}` and shows a generic error, the registration success text promises a notification that a rejection never sends, the device 403 text promises a socio can configure devices (impossible today).

## Decisions

- **Fallback (backend):** when sending the credentials email to the socio's email fails specifically with Resend's test-mode `validation_error` (name `validation_error` and the "You can only send testing emails to your own email address" message), resend the SAME credentials to `APPROVAL_NOTIFICATION_EMAIL` with a subject/body that says explicitly it is a backup forward of an email meant for `<original contactoSocio>` to be relayed manually (same wording family as the existing non-email-contact path). Any other Resend error, or a failure of the fallback itself, keeps the existing behavior (rollback + 502 retry page). The normal path (Resend accepts the direct send) is unchanged.
- **Time budget:** the direct send and the fallback share ONE total deadline that stays below the 15 s approve-transaction timeout (per-send 8 s x2 would exceed it and reintroduce a JSON 500).
- **Reactivate (frontend):** add a socios-only "show inactive" toggle in the catalog (needed to reach inactive products) and a "Reactivar" action visible only for inactive products and only for socios.
- **Edit without changes:** no HTTP call when the payload has no changed field; the modal closes quietly (documented in the code/tests).
- **Texts:** registration success no longer promises a rejection notice; the device 403 message no longer promises a socio can configure it.
- **Contract doc:** state that the device identifier is a shared secret of the business, not bound to a browser (an operational convention, not strong security); document the fallback. Backend writer edits the doc; the parent copies it to the frontend afterwards.

## Authority and boundaries

- Both repos, local commits only, NO push. Never read `.env*`.
- The dev servers (`nest start --watch` on :3000, `vite` on :5173) belong to someone else and MUST stay running: do not stop, restart or kill any node process. Backend edits recompile through the watcher; that is expected.
- Do not touch the test data of the previous session (approved request A, rejected request B, their context) unless the user asks.
- TDD on for the backend fallback (RED with the real Resend error shape simulated, then GREEN). Frontend: tests alongside each behavior change, RED first where practical. Runners: `npm.cmd run build|lint|test|test:e2e` (api), `npm run build|lint`, `npm test -- --run` (frontend).

## Tasks

- [x] **T1 — Backend fallback** (RED/GREEN, shared deadline, normal path unchanged). Commit `6df829a` `feat(email): forward credentials to the approver when Resend test mode rejects the socio`.
- [x] **T2 — Backend docs:** `doc/reglas-de-negocio.md` (fallback decision), `doc/api-contract-for-frontend.md` (fallback, device identifier is a shared secret). Commit `docs: document Resend fallback and device identifier semantics`.
- [ ] **T3 — Frontend reactivate:** toggle + action, socios only, tests.
- [ ] **T4 — Frontend nav link** to the catalog (update the outdated home-only test; active-state must not keep "Inicio" highlighted on `/app/productos`).
- [ ] **T5 — Frontend no-op edit:** no request, quiet close.
- [ ] **T6 — Frontend texts:** registration success and device 403.
- [ ] **T7 — Contract copy to the frontend** (parent) and commit.
- [ ] **T8 — Full checks in both repos, servers still running, user handoff** (URL, available test data).

## Route declaration

Delegated direct: one backend writer (T1-T2) and one frontend writer (T3-T6), in parallel (different repos, one writer per repo). Parent: T7, verification, handoff.

## Progress and evidence

### T1 (backend writer, commit `6df829a`)

- Route: delegated direct (backend writer). TDD on (Vitest, `npm.cmd test` / `npm.cmd run test:e2e`).
- RED (unit, `src/email/email.service.spec.ts`): `Tests  18 failed | 19 passed (37)`. 9 x `TypeError: isResendTestModeRecipientError is not a function`; fallback test threw `Error: Resend rejected the credentials email: validation_error: You can only send testing emails to your own email address (owner@example.test)...` (no second send); `AssertionError: expected 'Resend rejected the credentials email…' to match /fallback/i`; `expected undefined to deeply equal { deliveredTo: 'socio' }` (no return value yet); shared deadline: `expected 'Resend rejected the credentials email…' to be 'Resend credentials email timed out af…'`.
- RED (e2e, `test/business-registration.e2e-spec.ts`): `Tests  1 failed | 22 passed (23)`: `AssertionError: expected '<!doctype html>...' to match /aprobador/i` (the page claimed the email went to the socio when it was forwarded).
- GREEN: unit 181/181 (16 files), business-registration e2e 23/23, then the full runners (below).
- Design: `isResendTestModeRecipientError(error)` (`name === 'validation_error'` AND message contains `You can only send testing emails to your own email address`). `sendBusinessCredentialsEmail` returns `{ deliveredTo: 'socio' | 'approver-fallback' | 'approver-non-email-contact' }`; the approve page text is chosen from it. ONE total deadline: `CREDENTIALS_EMAIL_TIMEOUT_MS` is now 10 s and wraps the direct send plus the fallback in a single `withTimeout` (margin 15 s - 10 s = 5 s, pinned by the existing relation test); the fallback is never started once the deadline has passed. A failed fallback throws `<original>; the fallback to the approver also failed: <reason>` (no API key, no password).
- Existing e2e mocks that resolved `undefined` now resolve a `{ deliveredTo }` result (the real service always returns one).

### T2 (backend writer)

- `doc/reglas-de-negocio.md`: fallback rule and shared 10 s deadline. `doc/api-contract-for-frontend.md`: three approve 200 texts, backup email variant, 502 explanation (10 s total, failed fallback), device identifier is a shared secret (section 4 note), one Member/one Device and no endpoint to add them (B.4), Resend test mode (B.4). `src/docs/operation-examples.ts`: new 200 example; `test/docs.e2e-spec.ts` asserts it.
- `check-doc.mjs`: `36 json blocks, 58 anchors, 101 anchor links checked; problems: 0`.

### Runners after T1 + T2 (bazar-api)

- `npm.cmd run build` OK; `npm.cmd run lint` 0 errors, 2 known warnings (`test/sales-conflict.e2e-spec.ts`); `npm.cmd test` 181 passed (16 files); `npm.cmd run test:e2e` 143 passed (18 files). Real Resend was never called (SDK mocked in unit tests, `EmailService` mocked in e2e).

## Next step

Frontend writer (T3-T6), then parent T7 (copy the contract) and T8.

Memory mirror: `odd/resend-fallback-and-frontend-fixes/tasks`; repository locator: `odd/tasks/resend-fallback-and-frontend-fixes.md`.
