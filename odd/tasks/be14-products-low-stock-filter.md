# BE-14: low-stock filter on GET /products

Branch: `feat/be14-products-low-stock-filter` (from `main` @ current HEAD, post BE-13). TDD ON.

## Why

Part of a larger cross-repo request ("ajustes de producción" — 3 parts, frontend UX + Incidencias screen +
fiado/apartado). This is the one piece that lands in bazar-api: the frontend wants a "Poca existencia" filter
on the Productos catalog (Gestión), but `GET /products` currently has no stock filter, and the frontend
catalog store paginates server-side (`page`/`limit`, default 20) — a client-side-only filter would only ever
filter the current page, not the whole catalog. Confirmed by exploration, not assumed.

## Mapping (already verified, don't re-derive)

- `GET /dashboard/summary` already exposes a low-stock threshold query param named **`umbral`**
  (`src/dashboard/dto/dashboard-query.dto.ts`, `@Min(0) @Max(100_000)`, default **2**).
- `GET /products` (`src/products/dto/*.dto.ts`, `src/products/products.controller.ts`,
  `src/products/products.service.ts`) currently accepts only `search`, `includeInactive`, `page`, `limit` —
  unknown query params are rejected with 400 (confirmed in `doc/api-contract-for-frontend.md`).
- `doc/api-contract-for-frontend.md` (this repo) documents the exact current shape of `GET /products` — read it
  before touching the DTO, to match its existing validation/error style exactly.

## Decision (D1)

Add a new optional query param to `GET /products`, reusing the exact same name and default as the dashboard
for consistency: **`umbral`** (optional, `@IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000)`, NO
default applied server-side when absent — absent means "no filter", not "filter at 2"). When present, the
service filters to `stock <= umbral`. This mirrors the dashboard DTO's validation but must NOT default to 2
when the param is omitted (that would silently filter everyone's normal catalog view) — only the frontend
decides to pass `umbral=2` (or whatever default it uses) when the person turns the toggle on.

Reuse the dashboard's threshold semantics (`stock <= umbral`, not `<`), for consistency between the two
endpoints — confirm this against `dashboard.service.ts`'s actual comparison operator before implementing, don't
assume `<=` without checking.

## Tasks

- [x] **T1** Added `umbral` (optional, `@IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000)`, no
      default) to `ProductListDto` (`src/products/dto/product.dto.ts`); `ProductsService.list()` adds `stock: {
      lte: query.umbral }` to the `where` clause only when `umbral !== undefined`. Comparison operator confirmed
      against `dashboard.service.ts` (`stock: { lte: query.umbral }`) before reuse — matches, not assumed. RED
      confirmed the CURRENT behavior is a hard 400 (`forbidNonWhitelisted`) on an unknown `umbral`, not silent
      ignoring; GREEN after the DTO/service change. e2e coverage added: absent (unchanged), `umbral=0`,
      combined with `search`, invalid (`-1`, `100001`, `1.5`, `'abc'`) → 400 via `it.each`.
- [x] **T2** `doc/api-contract-for-frontend.md` updated: `umbral` added to the `GET /products` query param
      table, cross-referenced to the dashboard's identical name/semantics; also documented that `GET
      /products/:id/audit` accepts-and-ignores it (shares the same DTO), same pattern already used there for
      `search`/`includeInactive`.
- [x] **T3** Skipped deliberately: `doc/reglas-de-negocio.md` has no query-param/filter table for `GET
      /products` at all (its "Productos" section is high-level business rules; the one `includeInactive`
      mention is about who can request it, not a filter catalog) — no redundant section added, per this doc's
      own guardrail.
- [x] **T4** `npm run build` clean. `npm run lint` clean (only the 2 pre-existing warnings in
      `test/sales-conflict.e2e-spec.ts`, untouched by this task). `npm run test` → 24 files / 354 tests green.
      `npm run test:e2e` → 27 files / 525 tests green (+5 from the new `umbral` coverage). All re-verified by
      the coordinator independently after the writer's own report.

## Out of scope

- Do NOT touch the dashboard module, `GET /dashboard/summary`, or its existing `umbral` default (2) — that
  stays exactly as BE-13 left it.
- Do NOT touch anything under `src/deudas/`, `src/incidencias/` — unrelated to this task.
- Frontend wiring (the actual filter toggle UI, the query-param navigation from Inicio) happens in
  bazar-frontend, tracked separately. This task doc is backend-only.
