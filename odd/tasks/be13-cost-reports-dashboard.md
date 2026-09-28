# BE-13: mandatory purchase cost, sales-detail report with profit, dashboard summary

Branch: `feat/be13-cost-reports-dashboard` (from `main` @ 126c0cb). Not pushed.

TDD: ON (source: explicit user request). RED must be observed and recorded before each behavior. Runner:
`npx vitest run <file>` (unit), `npm run test:e2e` (e2e — needs the `postgres-test` container on 5433,
already up; run `npm run db:migrate:test` after the new migration). Machine: personal — full execution
authorized (install/build/test/Docker/migrations).

## Objective

1. `costoCompraMinor` (already `Product.purchaseCostMinor` in the schema) becomes **mandatory on create**,
   and **cannot be cleared once set** on edit. Existing products without a cost stay nullable, untouched.
2. Every `SaleItem` snapshots the product's cost at sale time (`unitCostMinor`, nullable), so a later cost
   change never rewrites the profit of a past sale.
3. `GET /reports/sales-detail`: what sold, by whom, and real profit — with an explicit, never-estimated gap
   for lines that predate cost tracking.
4. `GET /dashboard/summary`: one endpoint for the Gestión home screen.

## Mapping (evidence gathered before any code)

- **`Product.purchaseCostMinor Int?` already exists** (`prisma/schema.prisma`) — this is not a new column,
  just a stricter validation rule. `CreateProductDto`/`ProductMetadataDto` already validate it with
  `@IsOptional() @IsInt() @Min(0) @Max(MAX_MINOR_UNITS)` when present; removing `@IsOptional()` on create is
  the whole DTO-level change.
- **No "can't clear once set" rule exists anywhere** — this is business logic that needs the *current* DB
  value to decide, so it belongs in `ProductsService`, not a DTO decorator. `ProductsService.mutate()`
  (the shared lock-then-update helper used by `patch`) already reads `before` (the pre-update row) under
  `FOR UPDATE` before calling `tx.product.update` — the check goes right there: reject if
  `before.purchaseCostMinor !== null && dto.purchaseCostMinor === null`.
- **`SalesService.create()`** already takes a row lock (`FOR UPDATE` raw query) per item inside its single
  `$transaction`, reads the locked `product` row, then pushes a line object before the nested
  `tx.sale.create({ items: { create: lines.map(...) } } })`. `unitCostMinor: product.purchaseCostMinor` is
  captured off that same already-locked row, in the same line object — no new query, no new lock.
- **Money convention**: every monetary field in this schema is `Int` (minor units), never `Decimal`/`Float`;
  all arithmetic goes through `src/common/money.ts` (`dinero.js`), never raw `number` math. Follow this for
  every sum in the new report/dashboard code.
- **UTC-6 cutoff**: `src/common/business-time.ts`'s `parseRangeBoundary(value, 'start'|'end')` is already
  reused by `ReportsService` for `sales-by-period`/`sales-by-member` — reuse it verbatim for `sales-detail`.
  For the dashboard's "today"/"yesterday", add one small pure export, `currentBusinessDate(instant): string`
  (`YYYY-MM-DD`, reusing the file's existing private local-shift helper), then feed that string into
  `parseRangeBoundary` for both boundaries — no new date-math logic, just one new exported entry point into
  logic that's already trusted and tested.
- **Existing reports never use raw SQL** (`ReportsService` uses `prisma.sale.aggregate`/`.groupBy`/`.count`)
  and filter `contextId` **through the relevant relation** (`member: { contextId }` from `Sale`), even though
  a direct `contextId` column also exists on `Sale`/`Incidencia` — an established (if slightly redundant)
  convention in this codebase, replicated here for consistency rather than "fixed" as a drive-by change.
  `Product` is the one model whose `contextId` filter is direct (no relation needed).
- **Pagination pattern** `{ items, total, page, limit }` is already used identically by
  `ProductsService.list/.audits`, `SalesService.list`, `IncidenciasService.list`, `DeudasService.list` — same
  shape for `sales-detail`.
- **Guard**: `@UseGuards(SocioGuard)` at the controller class level (as `ReportsController` already does) —
  no extra composition needed, `SocioGuard` already chains `ContextGuard`→`AuthGuard`.
- **Incidencias**: count via `resolutionStatus: 'pendiente'`, filtered `sale: { member: { contextId } }`
  (same relation-based filter as `IncidenciasService.list`).
- **Deudas**: `status: 'pendiente'` already means "has an outstanding balance" (it only flips to `'saldada'`
  once fully paid), filtered `createdByMember: { contextId }`; the *exact* remaining amount still needs
  `totalMinor - sum(abonos.montoMinor)` per row (same math `DeudasService.registerAbono` already does).
- **"Poca existencia"**: no threshold concept exists anywhere in the schema — the dashboard's `umbral` query
  param (default 2) is the only source of truth for now, filtering `Product.stock <= umbral` directly
  (`Product.contextId` is a direct column, no relation join needed).
- **e2e pattern**: `Test.createTestingModule({ imports: [AppModule] })`, JWT signed manually (not through
  `/auth/login`), fixtures written directly via Prisma inside `withTestTenant(contextId, fn)` (RLS-aware),
  one unique `contextId` per spec file (e.g. `` `be13-sales-detail-${randomUUID()}` ``), `asColaborador`/
  `asSocio` request-builder helpers per file for the 403 tests — same shape as `test/reports.e2e-spec.ts` and
  `test/commissions.e2e-spec.ts`.

## Decisions

### D1. `sales-detail` aggregation key and the profit-availability rule (not 100% spelled out by the request — decided here, open to revisiting)
Each report row is one **(productId, memberId)** pair for the period — "what this person sold of this
product" — matching the requested per-row shape (`productId, nombre, memberId, nombre de la persona, ...`
all in one row). `SaleItem` has no `memberId` of its own; it's read off `saleItem.sale.memberId`. Built by
fetching every matching `SaleItem` (`sale.status: 'completada'`, `sale.receivedAt` in range,
`sale.member: { contextId }`) with `sale.memberId`, `sale.member.nombre`, `product.name`, `quantity`,
`subtotalMinor` (already precomputed per line, reused instead of recalculating `unitPriceMinor * quantity`),
and `unitCostMinor` — then reduced in application code into a `Map<`${productId}:${memberId}`, ...>`.

**Per-row profit rule**: `gananciaDisponible` is `true` only when **every** `SaleItem` in that
(product, member) group has a non-null `unitCostMinor`; if even one lacks it, the whole row's
`gananciaMinor` is `null` and `gananciaDisponible` is `false` — never a partial sum of the known subset
(that would look like a complete number while silently missing part of it, which is exactly what "nunca se
estima" is meant to prevent). The **period totals** are different on purpose: they sum `gananciaMinor` only
over the *individual* `SaleItem`s that have a cost (not per aggregated row) and separately report
`lineasSinCosto` as a raw count of `SaleItem`s missing one — so a socio always sees both "the real number for
what we know" and "how much of the picture is missing", rather than one blended, ambiguous figure.

### D2. Response shape
```
{
  items: [{ productId, productName, memberId, memberName, units, ingresoMinor, costoMinor, gananciaMinor, gananciaDisponible }],
  total,      // count of (product, member) rows, for pagination
  page, limit,
  totals: { ingresoMinor, gananciaMinor, lineasSinCosto },  // whole period, not just this page
}
```
Rows sorted by `ingresoMinor` descending (most revenue first — what a socio actually wants to scan first),
then `productName` for ties. Pagination is applied in-memory after building the full grouped set (bazar-scale
data, same assumption the rest of this codebase already makes for report-style endpoints).

### D3. `currentBusinessDate` (new, in `business-time.ts`)
`export function currentBusinessDate(instant: Date): string` — reuses the file's existing private
`toLocalReadable`, returns `YYYY-MM-DD`. "Today" = `currentBusinessDate(new Date())`; "yesterday" = the same
with one day subtracted before formatting. Both fed into `parseRangeBoundary(dateStr, 'start'|'end')` for the
actual instant range — no new offset math duplicated anywhere else.

### D4. Dashboard response shape
```
{
  ventasHoy: { totalMinor, count },
  ventasAyer: { totalMinor, count },
  gananciaHoyMinor,       // nullable, same all-or-nothing-per-day rule is NOT applied here — see below
  lineasSinCostoHoy,
  incidenciasPendientes,
  deudasPendientes: { totalMinor, personas },
  productosPocaExistencia: { umbral, total, items: [...up to 5...] },
}
```
`gananciaHoyMinor` uses the **period-totals rule** (D1), not the per-row rule: sum profit over today's
`SaleItem`s that have a cost, report `lineasSinCostoHoy` alongside it — a dashboard tile needs one number
"as complete as today's data allows" plus an honest asterisk, not a row that goes fully blank the moment one
sale that day lacks a cost.

### D5. Migration
`SaleItem.unitCostMinor Int?` — nullable, no default, no backfill (historical rows stay `null`, which is the
whole point: changing a product's cost later must never rewrite a past sale's profit).

## Minor follow-ups noted by review, not yet applied (non-blocking)
- Assert the exact 400 message ("purchaseCostMinor cannot be cleared once it has been set") in the
  clear-rejection test, not just the status code.
- Add a create-with-explicit-`purchaseCostMinor: null` case (distinct from omitting the field), asserting 400.
- Add a patch-with-explicit-`purchaseCostMinor: null` case on a legacy product that never had a cost
  (distinct from omitting the field), asserting 200 (the `before.purchaseCostMinor !== null` guard should
  not fire when it's already null).

## Checklist

- [x] **B1** Migration: `SaleItem.unitCostMinor Int?`. Applied to dev via
      `npx prisma migrate dev --name be13_sale_item_unit_cost` (uses `DATABASE_URL_MIGRATE` per
      `prisma.config.ts`) and to the test DB via `npm run db:migrate:test`. Commit `a3d536c`. Unit
      351/351, e2e 477/477, lint clean, build ok. Reviewed by Gentle AI (medium risk, `review-reliability`
      lens, approved, 2 non-blocking suggestions: confirm the migrate command in this doc — done here — and
      an optional DB-level `CHECK (unitCostMinor IS NULL OR unitCostMinor >= 0)`, skipped: the only write
      path copies an already-DTO-validated `Product.purchaseCostMinor`, matching how every other minor-unit
      column in this schema relies on DTO validation alone, no CHECK constraints).
- [x] **B2** `CreateProductDto.purchaseCostMinor` required (`@IsInt() @Min(0) @Max(MAX_MINOR_UNITS)`, no
      `@IsOptional()`). `ProductsService.mutate()`: reject clearing a set cost (400). Update Swagger examples.
      TDD: RED observed (create-without-cost and clear-a-set-cost both failed against unmodified code), then
      GREEN. Fixture fallout fixed: `test/products.e2e-spec.ts` and `test/multitenancy.e2e-spec.ts` were the
      only specs creating products through the real DTO path and needed `purchaseCostMinor` added (every
      other spec's Product fixture writes directly via Prisma, bypassing the DTO, unaffected). 482/482 e2e,
      351/351 unit, lint clean, build ok.
- [x] **B3** `SalesService.create()`: snapshot `unitCostMinor` off the already-locked product row into each
      line. TDD: RED observed for all 4 behaviors (cost present, cost null, snapshot survives a later cost
      change, mixed costed/cost-less lines in one sale), then GREEN. Discovery: the generated Prisma client
      (`src/generated/prisma`, gitignored) was stale after B1's migration — `npm run prisma:generate` fixed
      it; not a code bug, just a local regen step after any schema change. `unitCostMinor` intentionally not
      exposed on `GET /sales`'s response shape (not requested, and that endpoint isn't socio-only). 487/487
      e2e, 351/351 unit, lint clean, build ok.
- [x] **B4** `GET /reports/sales-detail`: aggregation (D1/D2), `SocioGuard`, pagination, UTC-6 cutoff via
      `parseRangeBoundary`. New `SalesDetailQueryDto` (extends `DateRangeQueryDto`) adds `page`/`limit` with
      the exact `ProductListDto`/`SaleListDto`/`DeudaListDto` pattern (`@Type(() => Number) @IsInt() @Min(1)
      @Max(1_000_000) page = 1` / `@Max(100) limit = 20`). `ReportsService.salesDetail()` fetches every
      matching `SaleItem` unpaginated (`sale.status: 'completada'`, `receivedAt` via `this.range()` reusing
      `parseRangeBoundary`, `sale.member: { contextId }`), reduces into a `Map<`${productId}:${memberId}`>`
      in application code (no raw SQL), sums money via `add`/`subtract`/`multiply` from `dinero.js` +
      `toDinero`/`toMinorUnits` from `src/common/money.ts` (the task brief's `sumMinor`/`addMinor` names don't
      exist in this codebase — used the actual existing convention instead, same one `SalesService`/
      `DeudasService` already use), sorts by `ingresoMinor` desc then `productName` asc, paginates in memory,
      and computes period `totals` over the raw (unpaginated, ungrouped) SaleItems per D1's different rule.
      Confirmed `Member.name` (not `nombre`) from `prisma/schema.prisma`. Added `@ApiExample('reportSalesDetail')`
      + its `operations` entry in `src/docs/operation-examples.ts` (reusing the existing `pagination`
      query-doc array). TDD: RED observed for all 9 e2e behaviors (costed row, cost-less row→null/false,
      mixed-cost aggregation→false, period totals split, non-completada excluded, UTC-6 cutoff, pagination,
      colaborador 403, cross-context isolation) against the unmodified code (404s), then GREEN
      (`test/reports-sales-detail.e2e-spec.ts`). Also had to add `'GET /reports/sales-detail'` to
      `SOCIO_ROUTES` in `test/impersonation-matrix.e2e-spec.ts` (a self-checking guard-metadata matrix that
      fails closed on any new SocioGuard route left out of it) — that describe.each added 5 more passing
      tests automatically. `sales-by-period`/`sales-by-member` re-run explicitly, still 3/3 green, untouched.
      502/502 e2e, 351/351 unit, lint clean (same 2 preexisting warnings), build ok.
- [ ] **B5** `business-time.ts`: add `currentBusinessDate` (D3) + its own unit test. `GET /dashboard/summary`
      (D4): today/yesterday sales, profit-with-gap, incidencias, deudas, poca existencia. TDD: RED first for
      each field, the UTC-6 boundary (a sale at 23:59 local vs 00:01 local), 403 for colaborador, isolation.
- [ ] **B6** Docs: `doc/reglas-de-negocio.md` (mandatory cost, snapshot, profit + its limitation) in
      **bazar-api**; `doc/api-contract-for-frontend.md` in **both** `bazar-api` and
      `bazar-frontend/doc` (the two endpoints, request/response shapes, guard, error cases).
- [ ] **B7** Verify: `npm run build`, `npm run lint`, `npm test` (unit), `npm run test:e2e`. Record RED/GREEN
      evidence per behavior above.

## Acceptance criteria

Creating a product without `purchaseCostMinor` is 400; creating with it succeeds; editing a product that
already has a cost to `null` is 400; editing without touching the field leaves it unchanged; editing a
product that never had a cost still allows saving without one. A sale's `SaleItem.unitCostMinor` matches the
product's cost *at the time of the sale*; changing the product's cost afterward never changes that stored
value or any past report/dashboard number derived from it. `sales-detail` rows never show a profit number
for a (product, member) pair with any cost-less line in it; period totals show a real (not estimated, not
zero) profit over only the lines that have cost, plus an honest count of the ones that don't. The dashboard's
`gananciaHoyMinor` follows the same never-estimate rule at the totals level. Every new endpoint: colaborador
gets 403, a different context's data is never visible. `sales-by-period`/`sales-by-member` are unmodified and
still pass their existing tests untouched.
