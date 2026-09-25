# Registration fields (nombre, apellidos, correo, telefono) and email format validation

File name note: the feature started as "registration fields + Kickbox verification" and the name was kept for traceability; Kickbox was dropped (see Decisions).

## Objective

Replace the free-text `contactoSocio` / `nombreSocio` of the public business registration (`POST /api/v1/business-registration`) with real fields, validating the email by format only.

## Contract (identical to the frontend brief)

`{ nombreNegocio: string (1..200, non-blank), nombre: string (1..100, non-blank), apellidos: string (1..100, non-blank), correo: valid email (max 254), telefono?: string (1..30, non-blank when present, no strict format) }`. Unknown fields stay a 400 (`forbidNonWhitelisted`); `nombreSocio` and `contactoSocio` are gone. 201 body unchanged: `{ id, status: 'pendiente', createdAt }`. The only validation failure is the standard class-validator 400.

## Decisions

- **Kickbox evaluated and DROPPED** (user scope change while implementing; no Kickbox code was ever written or committed in this branch). Reasons: a third-party dependency, a cost per verification attempt (the public endpoint has no rate limit, so it could be abused to burn credits), and one more point of failure in a low-volume flow. Consequence: only the FORMAT of the correo is checked; a well-formed but non-existent address is accepted. No `EMAIL_UNDELIVERABLE` code, no `didYouMean`, no `KICKBOX_API_KEY`, no `fetch` to any external service in the registration path.
- Naming: the person name splits into `nombre` + `apellidos`; the contact splits into `correo` (required) + `telefono` (optional). Founding Member name = `nombre apellidos` trimmed.
- DTO: `nombre`, `apellidos`, `correo`, `telefono` are trimmed BEFORE validation (`@Transform`), so a blank-only value is a 400. `correo`: `@IsEmail()` with the Spanish message `Escribe un correo válido, por ejemplo nombre@dominio.com`, which also covers an over-long address (isEmail rejects more than 254 characters). Follow-up found by the live check: the first version also had `@MaxLength(254)` with its own message, which wrongly told the user a MISSING correo was "too long"; it was removed so every failure of correo returns the same single message. The service stores the correo lower-cased. `telefono`: `@ValidateIf(v !== undefined)`, so `null` is rejected (omit the field), blank is rejected, trimmed value is stored; absent is stored as NULL.
- Prisma: `nombreSocio`/`contactoSocio` replaced by `nombre String`, `apellidos String`, `correo String`, `telefono String?`. Hand-written migration `20260925100000_registration_person_fields` (expand -> backfill -> contract) that preserves rows: nombre = old nombreSocio; apellidos = ''; correo = lower(trim(old contact)) when it matches the same conservative email pattern the app uses (and is <= 254 chars), else ''; telefono = old contact when it was not such an email, else NULL.
- Legacy rows (empty `correo`) keep working through the existing "relay through the approver" path: `normalizeSocioEmail('')` is `undefined`, so `socioEmail` is absent and `EmailService` sends the credentials to the approver with a note naming the socio and the telefono. The delivery value `approver-non-email-contact` was renamed `approver-no-socio-email` (the concept "non-email contact" no longer exists).
- Emails: approval email to the approver shows nombre + apellidos, correo and telefono (only when present); credentials email to the socio greets `Estimado/a {nombre}` (socio variant only); relay/backup variants show the full name, and correo (backup) / telefono; every interpolated value is HTML-escaped. Approve success page for "no usable socio email" names the socio and the telefono.
- Known gap (unchanged, documented): the public endpoint has no rate limit.

## Tasks

- [x] **T1 - RED tests** for DTO, service, emails, initial-credentials and e2e (fixtures moved to the new fields, new tests added). Route: delegated direct (this single backend writer).
- [x] **T2 - Schema + hand-written migration** (`prisma/schema.prisma`, `prisma/migrations/20260925100000_registration_person_fields/migration.sql`); dry-run inside a rolled-back transaction on the dev DB with extra legacy rows before applying.
- [x] **T3 - DTO with `@IsEmail` + service** (`create` stores the new fields; `approve` uses `correo`, founder name `nombre apellidos`).
- [x] **T4 - Emails, status page, username derivation, Swagger examples** (`normalizeEmailContact` -> `normalizeSocioEmail`, `deriveUniqueUsername({ correo })`, `src/common/full-name.ts`, `src/docs/*examples*`).
- [x] **T5 - Generate the client and apply the migration to BOTH databases** with `npx prisma migrate deploy` (dev) and `node scripts/migrate-test.mjs` (test). `db:provision*` and `db:migrate:test` (which chains provisioning) were NOT run: they rotate runtime role passwords.
- [x] **T6 - Docs** (`doc/reglas-de-negocio.md`, `doc/api-contract-for-frontend.md`), doc checker.
- [x] **T7 - Full checks** (build, lint, unit, e2e) and dev API health.

## Progress and evidence

TDD ON (source: the brief; runner Vitest through `npm.cmd test` / `npm.cmd run test:e2e`).

### RED (before any implementation)

- Unit (`npm.cmd test -- src/business-registration src/email`): `Test Files 4 failed | 2 passed (6)`, `Tests 64 failed | 71 passed (135)`. Sample failures: `TypeError: normalizeSocioEmail is not a function`; `TypeError: Cannot read properties of undefined (reading 'trim')` (`deriveUniqueUsername({ correo })`); `TypeError: Cannot read properties of undefined (reading 'replace')` (approval email, `escapeHtml(undefined)` for the new fields); `AssertionError: expected undefined to be '555-123-4567'` (service did not store telefono).
- DTO spec alone: `Failed Tests 11` (the old DTO has no `nombre`/`apellidos`/`correo`/`telefono`).
- E2E (`test/business-registration.e2e-spec.ts`): `Tests 24 failed | 8 passed (32)`; e.g. `Invalid prisma.businessRegistrationRequest.create() invocation` (new columns unknown to the old client/schema).
- The Spanish-message, exact-body and "no external call" assertions were added right after the scope change (IsEmail instead of Kickbox), when the DTO already existed; they were green on first run except two bugs in the new tests themselves (a name collision that made a count 2, and an outdated mock enum), fixed before commit.

### GREEN

- Unit `218 passed (17 files)`; business-registration e2e `34 passed`; full e2e `154 passed (18 files)`.
- Runner results after both commits: `npm.cmd run build` OK; `npm.cmd run lint` 0 errors, 2 known warnings (`test/sales-conflict.e2e-spec.ts`); `npm.cmd test` 218/218; `npm.cmd run test:e2e` 154/154.
- The exact 400 body for an invalid correo (asserted in e2e): `{ "statusCode": 400, "message": ["Escribe un correo válido, por ejemplo nombre@dominio.com"], "error": "Bad Request" }`.
- No external network call: e2e spies on `globalThis.fetch` and asserts it is never called during a successful and a rejected registration; a source grep finds no `fetch(`/`axios`/external URL outside specs.

### Migration and data (dev DB `bazar_dev` in `bazar-api-postgres-1`, 3 rows; test DB in `bazar-api-postgres-test-1`)

Before (`nombreSocio | contactoSocio`):

- `Bolsas Mama de Adid segunda prueba | Mama de Adid | 555-123-4567 | aprobado`
- `Prueba E2E Aprobar 20260924-1901 | Socio Prueba Aprobar | albert.gonzalez0297@gmail.com | aprobado`
- `Prueba E2E Rechazar 20260924-1901 | Socio Prueba Rechazar | albert.gonzalez0297+bazar-e2e-b@gmail.com | rechazado`

After (`nombre | apellidos | correo | telefono`), ids, status and `createdContextId` untouched, total still 3:

- `Mama de Adid | '' | '' | 555-123-4567`
- `Socio Prueba Aprobar | '' | albert.gonzalez0297@gmail.com | NULL`
- `Socio Prueba Rechazar | '' | albert.gonzalez0297+bazar-e2e-b@gmail.com | NULL`

Drift check: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` against the dev DB: `No difference detected.` (exit 0). The migration was first rehearsed inside `BEGIN; ...; ROLLBACK;` with extra legacy rows (a padded upper-case email, a multi-address text, an HTML text): they backfilled to `foo.bar@example.com` / `''` + text / `''` + text as designed.

### Commits

- `3805e4f` `feat(business-registration): split the contact into nombre, apellidos, correo and telefono` (schema, migration, DTO, service, emails, examples, tests).
- Docs + this record: see the last commit of the branch (`docs: document the registration fields and email format validation`).

### Not verified / notes

- Deliverability of a well-formed address is intentionally not verified (dropped scope).
- At the end of the work nothing was listening on `:3000` (the `nest start --watch` process was gone); it was not started from here by instruction. `:5173` (vite) was still listening.
