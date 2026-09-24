# Adopt UUIDv7 for server-generated identifiers

Use the official `uuid` package to generate time-ordered UUIDv7 identifiers for every record created by runtime backend services, while preserving client-owned sale IDs and intentional seed fixtures.

## Scope and constraints

- Explicitly assign UUIDv7 before Prisma creates Product, ProductAudit, SaleItem, Incidencia, Deudor, Deuda, and Abono records.
- Keep `Sale.id` supplied by the client and recommend UUIDv7 in `CreateSaleDto` without changing ownership.
- Do not alter fixed seed identifiers.
- Document the policy in `doc/reglas-de-negocio.md`.
- Delivery strategy: `ask-on-risk`; expected change is below 400 authored lines.
- TDD mode: enabled by the project convention from BE-05; runner is Vitest (`npm test` / `npm run test:e2e`).

## Tasks

- [x] IDS-1 Add `uuid` with native UUIDv7 support and a shared server-ID helper.
- [x] IDS-2 Add failing UUIDv7 assertions for server-created records.
- [x] IDS-3 Wire UUIDv7 into every runtime server create path, excluding Sale and seed fixtures.
- [x] IDS-4 Document server, seed, and frontend ownership rules.
- [x] IDS-5 Run focused tests, build/lint/unit verification, and commit the work unit.

## Acceptance criteria

- New Product, ProductAudit, SaleItem, Incidencia, Deudor, Deuda, and Abono identifiers validate as UUID version 7.
- Client-supplied Sale identifiers remain unchanged.
- Seed fixture identifiers remain unchanged.
- Build, lint, unit tests, and end-to-end tests pass.

## Progress

- Installed exact dependency `uuid@14.0.2`, the latest stable npm release checked on 2026-09-23.
- RED: `npm test -- src/common/server-id.spec.ts` failed because the helper did not exist yet.
- GREEN: the focused helper suite passed (2 tests), all unit tests passed (39 tests), and the four affected end-to-end suites passed (55 tests).
- `npm run build` passed. `npm run lint` passed with two pre-existing warnings in `test/sales-conflict.e2e-spec.ts`.
- Runtime harness: affected HTTP creation paths were exercised by the focused end-to-end suites against the isolated test database.
- Rollback boundary: remove the `uuid` dependency, `src/common/server-id*`, explicit IDs in the three services, UUIDv7 assertions, DTO note, and identifier documentation.

## Next step

Commit as `feat(ids): adopt UUIDv7 for server-generated identifiers`; push remains a separate user decision.
