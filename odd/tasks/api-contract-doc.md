# API contract reference for the frontend

Write `doc/api-contract-for-frontend.md`: a complete, code-verified reference of every endpoint of `bazar-api` so the frontend can keep building views without guessing. The backend repository is the source of truth; the user copies the file to `bazar-frontend` by hand.

## Authority and boundaries

- Authorized root: `bazar-api/`, branch `feat/backend-e0-be11-multitenancy`. Documentation only: no source or test changes.
- Never read `.env` (a permission rule denies it). Live checks use a temporary test account/member/device that is deleted afterwards.
- TDD does not apply (docs). Verification replaces it: every route in the code appears in the document, and representative behaviors are confirmed against a running server, not against Swagger or memory.
- Commit: `docs: add API contract reference for frontend`. The user left the push to the agent's judgment.
- Language: the document is in Spanish (the user named its sections in Spanish and `doc/reglas-de-negocio.md` is Spanish); JSON, identifiers and paths stay in English. This record is in English.

## Ground truth used for coverage (route inventory taken from the code)

33 routes in 12 controllers (the first count of 34 in this record was wrong: `GET /business-registration` does not exist): `GET /` (`AppController`), `POST /auth/login`, `POST /business-registration`, `GET /business-registration/{approve,reject}`, `GET /commissions`, `PATCH /settings/commission-rate`, `POST|GET /deudas`, `GET /deudas/:id`, `POST /deudas/:id/abonos`, `POST /devices/identify`, `GET /incidencias`, `GET /incidencias/:id`, `PATCH /incidencias/:id/resolver`, `GET /members`, `PATCH /members/:id/commission-rate`, `PATCH|DELETE /members/:id`, `PATCH /members/:id/reactivate`, `POST|GET /products`, `PATCH /products/:id`, `GET /products/:id`, `GET /products/:id/audit`, `POST /products/:id/image`, `DELETE /products/:id`, `PATCH /products/:id/reactivate`, `GET /reports/sales-by-period`, `GET /reports/sales-by-member`, `POST|GET /sales`, `GET /sales/:id`. All behind the global prefix `/api/v1`. Outside the prefix: `/docs`, `/docs-json`, `/docs-yaml` (only when `ENABLE_API_DOCS=true`, Basic Auth) and static `/uploads/products/...`.

Modules the user listed, in order: Auth, Members, Devices, Products, Sales, Incidencias, Commissions (which also owns `settings`), Reports, Deudas, Business Registration.

Findings worth documenting that the request did not mention: every controller uses `ValidationPipe({ transform, whitelist, forbidNonWhitelisted: true })`, so an unknown field such as `contextId` is a `400`, not ignored.

## Tasks

- [x] **T1 — Draft the document** from controllers, DTOs, guards, services and e2e fixtures (one delegated writer).
- [x] **T2 — Coverage check:** every route above appears in the document with the right method, path and audience; no invented route.
- [x] **T3 — Live verification** against a running server with a temporary account, member and device: login, member selection, device identification, the headers, pagination shape, the 201 sale with a conflict status in the body, the 400 for an unknown field, 401/403/404/409 cases, CORS state.
- [x] **T4 — Fix every discrepancy** found in T2/T3 in the document.
- [x] **T5 — Commit** (`docs: add API contract reference for frontend`); decide the push.

## Progress and evidence

- T1: one delegated writer drafted `doc/api-contract-for-frontend.md` (Spanish, 1927 lines) from controllers, DTOs, guards, services and e2e fixtures, citing `file:line` per endpoint. It read the code only; it did not run anything.
- T2: a script extracts the routes from the controllers and compares them with the route index of the document: **33 in the code, the same 33 in the document, none missing, none extra**. Also 36 of 36 JSON blocks parse and all 90 internal links resolve (re-run after the corrections).
- T3: the whole document was read by the parent and its claims were exercised against a running server (`npm run start:dev`, dev database, runtime role) with a temporary context `e2e-contract` (account, socio, colaborador, authorized and unauthorized device): about 200 requests covering auth and guards (including the missing-header, wrong-role and wrong-device 403s), pagination bounds, products (create, edit, audit, soft delete, includeInactive, image upload with real PNG/SVG/oversize cases), members, sales (idempotent replay 200, different payload 409, every 400/403 message, date-only and future `occurredAt`, and a real concurrent race on the last unit that returned `201 completada` and `201 rechazada_por_conflicto` with the documented body), incidencias (resolve, 409 on resolve twice), commissions, reports, deudas and abonos, the business-registration validation and HTML pages. No valid `POST /business-registration` was sent, to avoid a real email. Everything matched the document except the points below.
- T4: corrections applied from the live run: two 404 formats (JSON under `/api/v1`, an Express HTML page outside the prefix), 413 for a JSON body over ~100 kb, 400 with a string message for a non-JSON body, the exact multer messages for image errors (`Unexpected file field - foto`, `Too many fields`, `Too many files`, `File too large`), date-only `occurredAt` accepted, `from` > `to` answers 200 with zeros, and week/ordinal ISO dates answer 400 with a string `Invalid date: <value>`. Appendix B.2 now records what was verified live; a new B.4 lists known backend problems.
- Known backend problems recorded in B.4 (verified, not fixed, out of scope of this documentation task): (1) an approved business has no Account or Device and cannot log in; (2) `renderStatusPage` interpolates `nombreNegocio` unescaped (stored XSS in the approval/rejection page; the email does escape it); (3) no rate limit on the public registration endpoint; (4) `requestFingerprint` and the audit snapshot's `imagePath` leak in responses; (5) replacing an image keeps the old file; (6) the Vite dev proxy does not cover `/uploads`; (7) the current frontend Axios client only sends `Authorization`; (8) `GET /sales/:id` only needs a token; (9) a 401 cannot tell an expired token from a disabled account.
- Facts that contradict the request's wording: the `x-member-id`/`x-device-id` headers are NOT required on every protected route (only where `ContextGuard`/`SocioGuard` apply; `GET /products`, `GET /members`, `POST /devices/identify` and `GET /sales/:id` need only the token); `POST /devices/identify` also requires `name`; an unknown device is never auto-registered.
- T5: cleanup done (temporary context deleted with 0 rows left, `bazar-local` intact with 2 Members, 3 Devices and 1 Account, uploaded test image removed, server stopped). Commit `docs: add API contract reference for frontend`, not pushed.

## Next step

The user reviews the document and decides the push; the backend problems in B.4 are separate follow-ups.

Memory mirror: `odd/api-contract-doc/tasks`; repository locator: `odd/tasks/api-contract-doc.md`.
