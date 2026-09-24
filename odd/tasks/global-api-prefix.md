# Align the backend with the `/api/v1` contract

Apply one global controller prefix so the existing frontend (`VITE_API_URL=http://localhost:3000/api/v1`) can reach the real API, keep the approval and rejection links inside that same contract, and remove the route-wildcard warning the prefix exposes. This record replaces the stale one left by an interrupted earlier session.

## Authority and boundaries

- Authorized root: `bazar-api/`, branch `feat/backend-e0-be11-multitenancy` (BE-11 already pushed at `ed80cba`).
- Allowed: source, tests, docs and local runtime verification (dev server, curl). Atomic Conventional Commits, no AI attribution. **No push** until the user decides.
- Never read `.env` (a permission rule denies it). The user's `.env` now has the runtime role, owner URLs and a real `RESEND_API_KEY`; do not send real registration emails during verification (use the mocked-email e2e).
- TDD: **on** (repo policy from BE-05). RED first where there is new behavior. Runners: `npm run build`, `npm run lint`, `npm test`, `npm run test:e2e`.
- Native review: RDD reports `on (decided by default)`; run only with the user's per-candidate consent. The outcome for this task is recorded under "Progress and evidence".

## Starting state (audited 2026-09-24, nothing trusted beforehand)

Uncommitted work left by an earlier interrupted session (last edit 13:06): `src/main.ts` (+1), the registration service links (+ `baseUrl()`), a new `business-registration.service.spec.ts`, a rewrite of `test/business-registration.e2e-spec.ts` that boots the real `main.ts`, and README, `doc/reglas-de-negocio.md`, `.env.example` hunks, plus an untracked `registro.json` (a manual-test file) and this record.

Audit result:

- **Kept as is:** `app.setGlobalPrefix('api/v1')` in `main.ts` (correct position: after `NestFactory.create`, before static storage, docs and `listen`); the service links under `/api/v1/business-registration/...` and the hardened `baseUrl()` (trims, treats blank as unset, strips trailing slashes); the new unit spec; the e2e rewrite (it runs the actual `main.ts` with the mocked email and asserts prefixed routes, unprefixed 404s, prefixed OpenAPI paths, explicit `/docs*` and `/uploads/products` mounts); the README, business-rules and `.env.example` hunks (consistent with each other and with the code).
- **Compatible with BE-11 work done afterwards:** the working-tree service still contains the `approve` fix that sets `app.context_id`; `src/email/email.service.ts` (the Resend error handling) was never touched. A full e2e run with these edits present passed (18 files / 125 tests) before this task started, so they coexist without conflict.
- **To correct:** (1) `consumer.apply(TenantContextMiddleware).forRoutes('*')` in `src/app.module.ts` becomes `/api/v1/*` behind the prefix, which `path-to-regexp` v8 (Express 5) rejects; Nest auto-converts it to `/api/v1/{*path}` and logs `WARN [LegacyRouteConverter]`. (2) No test proves the tenant middleware still applies behind the prefix (an authenticated request through the real bootstrap). (3) `APP_BASE_URL` that already ends in `/api/v1` would produce `/api/v1/api/v1/...` links. (4) The task record was stale.
- **Discarded:** the stale progress section and the "exactly one final commit" plan of the earlier record (replaced by this one and by the atomic commits below).

## Decision: approval and rejection links stay inside `/api/v1`

Reasons: they are ordinary controller routes, so one contract, one reverse-proxy rule and one place to version; excluding them would need `setGlobalPrefix(..., { exclude })` and would leave an unversioned public surface that Swagger and the frontend contract would not describe; and no valid link exists in the old unprefixed form (the only approved token was already used, the other pending request never had an email sent). The email link therefore embeds `APP_BASE_URL` (server origin) plus `/api/v1/business-registration/{approve,reject}`.

## Tasks

- [x] **T1 — Tenant middleware registration without the warning.** RED: a test that boots the production bootstrap and fails while `LegacyRouteConverter` warns. Use the explicit optional wildcard `forRoutes('{*path}')` (matches every path and the bare root, with and without the prefix).
- [x] **T2 — Tenant scope proven behind the prefix.** An authenticated request through the real bootstrap (`GET /api/v1/products` with a token, member and device headers) returns only its own context's products; no cross-context leak; the bare root and a public route still work.
- [x] **T3 — `APP_BASE_URL` robustness.** RED unit case: an origin that already ends in `/api/v1` does not duplicate the prefix in the links.
- [x] **T4 — Docs match the verified reality** (`README.md`, `doc/reglas-de-negocio.md`, `.env.example`), including the wildcard fix and the `APP_BASE_URL` rule.
- [x] **T5 — Full checks, curl against a real server, cleanup, commits.** `registro.json` removed; no push.

## Acceptance and checks

- `npm run build`, `npm run lint` (2 pre-existing BE-09 warnings allowed), `npm test`, `npm run test:e2e` pass.
- Real server: `GET /api/v1/products` without token 401; `GET /products` 404; `GET /api/v1` 200; `POST /business-registration` (old path) 404; `GET /api/v1/business-registration/approve?token=x` returns the invalid-link page (404 body, not a routing 404); startup log has no `LegacyRouteConverter` warning.
- `git diff --check` clean; the commits say what was kept, corrected and discarded.

## Progress and evidence

- Audit (see "Starting state"): the adopted work was kept, three things corrected, the stale record replaced. A full e2e run with the adopted edits present had already passed (18 files / 125 tests) before this task started.
- One delegated writer implemented T1 to T3 with RED first; the parent re-ran everything independently.
  - T1 RED: "boots through main.ts without route-conversion warnings" failed with `WARN [LegacyRouteConverter] Unsupported route path: "/api/v1/*" ... auto-convert to "/api/v1/{*path}"` (the message goes through `Logger#warn`). Fix: `consumer.apply(TenantContextMiddleware).forRoutes('{*path}')` in `src/app.module.ts`; the writer read Nest's `legacy-route-converter.js`, which converts `/api/v1/*` to exactly that form, so behavior is unchanged.
  - T2 (guard, no RED possible because the behavior already worked): an authenticated `GET /api/v1/products` through the real `main.ts` returns 200 with only its own context's product and no leak, and the same request without the prefix is 404. Mutation check: changing the registration to `forRoutes('/zzz')` made it fail with 500 (`setActiveContextId called without an active tenant request scope`), so it really guards the tenant middleware behind the prefix.
  - T3 RED: three cases with `APP_BASE_URL` ending in `/api/v1` produced `/api/v1/api/v1/business-registration/approve`; `baseUrl()` now strips a trailing `/api/v1` (still trims, blank means unset, trailing slashes stripped).
- Parent verification (plain runs with the user's real `.env`): `npm run build` 0 errors; `npm run lint` exit 0 with the 2 pre-existing BE-09 warnings; `npm test` 11 files / 83 tests; `npm run test:e2e` 18 files / 127 tests; no `LegacyRouteConverter` text in the e2e output; `git diff --check` clean.
- Real server (`npm run start:dev`, connected as `bazar_app`, `rolsuper = f`, `rolbypassrls = f`), no email sent: `GET /api/v1/products` without token 401; `GET /products` 404 (Express routing error); `GET /api/v1` 200; `GET /` 404; old `POST /business-registration` 404; `GET /api/v1/business-registration/approve?token=not-a-real-token` and `.../reject` 404 with the application's own "Enlace inválido" page (proof the route exists, unlike a routing 404); old `GET /business-registration/approve` 404 (routing); `GET /docs` 401 (explicit mount at the origin, protected). Boot log: `Found 0 errors`, no `WARN`. The server was stopped afterwards.
- Docs: `README.md`, `doc/reglas-de-negocio.md` and the `.env.example` comment describe the prefix, the origin-only `APP_BASE_URL` (a trailing `/api/v1` is normalized) and the `{*path}` registration; the `.env.example` comment ("do not include /api/v1") stays accurate as guidance.
- `registro.json` (a manual-test file left in the repo root) removed.
- Commit: `646e291` (`fix(api): add global /api/v1 prefix`), 8 files, +271/-37 authored lines; one coherent unit because the wildcard problem exists only behind the prefix. Not pushed.
- Native review (2026-09-24, user-consented): APPROVED for exactly these two commits (`646e291`, `7fb0781`; medium, 9 files, 368 lines, one `review-reliability` lens, target `sha256:e59d6a08…db6a36`); receipt acknowledged and the authority burned, persisted review state clean. Path to get there: `gentle-ai sync --agent claude-code` was needed first (`managed_assets_outdated`); the first lineage was started from a preflight run without `--agent claude-code`, so `capture-result` failed `invalid_request` (no `--agent` in the provider tokens), and it was released with the user's maintainer authorization (`operator_disposition`, nothing discarded) and restarted with the agent-bound preflight. Two advisory, non-blocking findings, no correction opened: (1) WARNING `R3-bootstrap-capture-ordering` (`test/business-registration.e2e-spec.ts:75-91`): the reviewer worried that the spies are restored before `bootstrap()` finishes if `main.ts` does not await it; checked against the code, `src/main.ts:21` does `await bootstrap()` at top level, so the dynamic `import()` resolves only after `app.listen` and the premise does not hold (the RED run also captured the warning); (2) SUGGESTION `R3-baseurl-case` (`business-registration.service.ts:36-42`): `baseUrl()` strips `/api/v1` only in lowercase; low risk, optional follow-up. The whole-branch candidate against `main` (high, 133 files, 16041 lines) failed `lens_context_budget_exceeded` (nothing created) and was not reviewed. RDD reports `on (decided by default)`.

## Next step

Wait for the user's decision on the push. Optional: the native review needs the user's consent.

Memory mirror: `odd/global-api-prefix/tasks`; repository locator: `odd/tasks/global-api-prefix.md`.
