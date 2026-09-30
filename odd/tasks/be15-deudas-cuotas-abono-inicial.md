# BE-15: abono inicial explícito, cuotas planeadas, snapshot de costo, reportes de deudas

Branch: `feat/be15-deudas-cuotas-abono-inicial` (from `main`, on top of the 2 unpushed commits `031b06a`
feat(email) and `5609c6f` feat(deploy) — paused, not this task's concern, don't touch). TDD ON. Personal
machine, full execution authorized.

## Why

Production feedback on the Deuda/fiado module: no explicit initial-abono capture, no payment-schedule
concept, no debt-specific reporting. See the user's full pasted spec (not reproduced here in full — this doc
captures the decisions and mapping, refer to conversation for the original business framing if needed).

## Mapping (already verified against real code by a research fork — don't re-derive)

**Schema today** (`prisma/schema.prisma`): `Deudor { id, nombre, telefono?, notas?, contextId, createdAt }`.
`Deuda { id, type (fiado|apartado), deudorId, productId, contextId, cantidad, totalMinor, status
(pendiente|saldada, DERIVED — never written directly by API), createdByMemberId, createdAt }`. `Abono { id,
deudaId, contextId, montoMinor, receivedByMemberId, receivedAt, nota? }`. **No cost snapshot field exists on
Deuda. No CuotaPlaneada model exists.**

**`deudas.service.ts`** (full file already read): `create()` doesn't accept any initial-abono field today.
`registerAbono()` locks the Deuda (`FOR UPDATE`), sums existing abonos via `tx.abono.aggregate`, rejects if it
would exceed the balance, creates the Abono, and — **in the same transaction** — flips `status` to `'saldada'`
if the sum reaches `totalMinor`. **The balance is ALWAYS computed by summing `Abono.montoMinor`, never read
from a derived column** — this is exactly the invariant `CuotaPlaneada` must never touch.

**Routes, all already exist**: `POST /deudas` (SocioGuard), `GET /deudas` (SocioGuard, already paginated with
`status`/`search`/`sort` by `createdAt` only — no balance-based sort, no "atrasado" filter yet), `GET
/deudas/:id` (SocioGuard), `POST /deudas/:id/abonos` (ContextGuard, not socio-only).

**Multi-tenancy**: `src/database/tenant.extension.ts`'s `TENANT_SCOPED_MODELS` Set already includes
`'Deudor', 'Deuda', 'Abono'`. A new `CuotaPlaneada` model **must be added to this Set**, get its own
`contextId @default("legacy-unassigned")` column, and a mirrored RLS policy (pattern documented in
`doc/reglas-de-negocio.md`'s "Multi-tenancy (BE-11)" section). Any raw query against it (mirroring
`registerAbono`'s `FOR UPDATE`) must filter `contextId` by hand, same discipline already used there.

**Reports**: `reports.service.ts` has zero Deuda/Abono content today — new territory. Established pattern to
replicate: `parseRangeBoundary(query.from/to)` for the date range, `dinero.js` for all money arithmetic,
in-memory aggregation grouped with a `Map` (not raw SQL), always filtered by `contextId`. `salesDetail()`'s
"never estimate profit, `gananciaDisponible: false` if cost is missing anywhere in the group" pattern is the
direct template for "deudas liquidadas con ganancia" below.

**Docs**: both `doc/api-contract-for-frontend.md` and `doc/reglas-de-negocio.md` already accurately describe
today's (pre-this-task) contract, no existing discrepancies to fix incidentally.

## Decisions

- **D1 (abono inicial)**: `abonoInicialMinor` becomes a **required** field on `CreateDeudaDto` (`Int, @Min(0)`)
  — required, not optional, specifically so the caller must always be explicit (can be `0`), never silently
  omitted. When `> 0`, `create()` creates the first `Abono` (today's date, `receivedByMemberId` = the acting
  Member) **inside the same transaction** that creates the Deuda — mirrors `registerAbono`'s own balance-check
  discipline (an initial abono cannot exceed `totalMinor` either; reuse that guard, don't duplicate its logic).
- **D2 (CuotaPlaneada)**: new model, tenant-scoped like its siblings:
  ```prisma
  model CuotaPlaneada {
    id                String   @id @default(uuid()) @db.Uuid
    deudaId           String   @db.Uuid
    contextId         String   @default("legacy-unassigned")
    fechaEsperada      DateTime @db.Timestamptz(3)
    montoEsperadoMinor Int
    createdAt         DateTime @default(now()) @db.Timestamptz(3)
    deuda             Deuda    @relation(fields: [deudaId], references: [id])
    @@index([deudaId, fechaEsperada])
    @@index([contextId])
  }
  ```
  Add the reverse relation `cuotasPlaneadas CuotaPlaneada[]` on `Deuda`. Add `'CuotaPlaneada'` to
  `TENANT_SCOPED_MODELS`, write the mirrored RLS migration exactly like the existing ones (same file/pattern as
  the BE-11 multitenancy RLS migration — read it before writing a new one, don't reinvent the SQL shape).
  **`CuotaPlaneada` rows are NEVER read by any balance calculation** — write a test that proves this explicitly
  (create cuotas that don't match any real payment, assert the balance is unaffected).
- **D3 (cuotas endpoints, socio-only)**: `POST /deudas/:id/cuotas` (add one), `PATCH
  /deudas/:id/cuotas/:cuotaId` (edit), `DELETE /deudas/:id/cuotas/:cuotaId` (remove) — all `SocioGuard`, same
  as creating a Deuda itself. `CreateDeudaDto` also accepts an optional `cuotasPlaneadas?:
  {fechaEsperada, montoEsperadoMinor}[]` array, created in the same transaction as the Deuda when present.
- **D4 (liquidation status)**: already fully correct and derived (`status: 'saldada'` flips automatically
  inside `registerAbono`'s transaction) — no schema/logic change needed for the status itself. **But**: to
  answer "deudas liquidadas EN EL PERIODO" (task 5 below) requires knowing WHEN it became saldada, and no
  timestamp exists for that moment today. **Added decision (not in the original ask, but a real technical
  necessity to fulfill it)**: add `saldadaAt DateTime? @db.Timestamptz(3)` to `Deuda`, set inside
  `registerAbono`'s existing transaction at the exact moment `status` flips to `'saldada'` (never set any other
  way, never backfilled for historical saldada rows — those stay `null`, which is honest: we don't know when
  they actually settled).
- **D5 (cost snapshot)**: add `unitCostMinor Int?` to `Deuda`, copied from `Product.purchaseCostMinor` at
  creation (same nullable, never-estimated pattern as `SaleItem.unitCostMinor` — null stays null forever, no
  backfill, no guessing). Needed to compute profit for "deudas liquidadas" in the report (D7).
- **D6 (list/filter/sort)**: `GET /deudas` gains:
  - `atrasado?: boolean` filter — server-computed: a Deuda is "atrasado" when it has at least one
    `CuotaPlaneada` with `fechaEsperada` in the past AND the sum of its `CuotaPlaneada.montoEsperadoMinor` up to
    today exceeds the sum of its real `Abono.montoMinor` up to today. Compute this in application code (same
    in-memory-aggregation discipline as reports), not a fragile raw SQL expression — this list is not
    performance-critical at this project's scale.
  - `sort`: extend beyond `createdAt` to also support ordering by pending balance (descending: most owed
    first) and by the earliest overdue `CuotaPlaneada.fechaEsperada`. Implementation approach (in-memory sort
    after fetching a bounded page, vs. a computed-column SQL sort) is the delegated writer's call — document
    whichever is chosen and why.
- **D7 (reports, new)**: Confirm the exact existing report contract/endpoint names in
  `doc/api-contract-for-frontend.md` before adding new query params or a new endpoint — prefer extending the
  existing sales report endpoint(s) with two additional result sections over inventing a wholly separate
  endpoint, unless the existing endpoint's shape genuinely can't carry them cleanly (delegated writer's
  judgment call, documented).
  - **"Abonos recibidos en el periodo"**: every real `Abono` with `receivedAt` in `[from, to]`, regardless of
    whether its Deuda is still active or already saldada. Columns: `fecha` (`receivedAt`), `deudor`, `monto`,
    `type` (fiado/apartado, from the parent Deuda).
  - **"Deudas liquidadas en el periodo"**: Deudas where `saldadaAt` falls in `[from, to]`. Profit per row =
    `totalMinor - (unitCostMinor * cantidad)` when `unitCostMinor` is not null, else `gananciaDisponible: false`
    (never estimate) — exact same convention as `salesDetail`.
  - **Combined total**: "dinero total ingresado en el periodo" = sales report's existing cash total + this
    period's abonos-received total. Expose this as a computed field in the response, don't make the frontend
    add two numbers from two different endpoints if they can come pre-summed from one response.

## Tasks

- [x] **T1** Schema: `CuotaPlaneada` model, `Deuda.unitCostMinor`, `Deuda.saldadaAt`, migration
      (`prisma/migrations/20260929120000_be15_deudas_cuotas_abono_inicial/migration.sql`, applied to the test
      DB), RLS mirror (mirrors `20260924081000_multitenancy_rls`), `TENANT_SCOPED_MODELS` update
      (`src/database/tenant.extension.ts`). TDD: "CuotaPlaneada rows that do not match any real payment never
      move the saldo or status" and "saldadaAt is set exactly once..." in `test/deudas.e2e-spec.ts` — both pass.
- [x] **T2** `abonoInicialMinor` required on `CreateDeudaDto`, first-Abono-in-same-transaction logic (D1),
      shared `assertWithinBalance` guard reused by `create()` and `registerAbono()`
      (`src/deudas/deudas.service.ts`). TDD: 4 tests in `test/deudas.e2e-spec.ts` ("abono inicial (BE-15 D1)")
      — 0 creates zero Abonos, >0 creates exactly one dated today, an amount equal to the total settles
      immediately (`saldadaAt` set), an excessive amount is rejected with the exact `registerAbono` error
      shape and rolls back everything (no Deuda, no stock change) — all pass.
- [x] **T3** Cuotas endpoints (D3) + `unitCostMinor` snapshot at creation (D5)
      (`src/deudas/deudas.controller.ts`, `src/deudas/dto/cuota-planeada.dto.ts`). TDD: CRUD via HTTP, cuotas
      at Deuda creation, 403 for a colaborador on all three endpoints, cost snapshot null/non-null — all pass.
- [x] **T4** `GET /deudas` filter/sort additions (D6) (`src/deudas/dto/deuda-list.dto.ts`,
      `src/deudas/deudas.service.ts.list`). TDD: atrasado false/false/true across the 3 named scenarios, sort
      by saldoPendiente desc, sort by cuotaVencida — all pass.
- [x] **T5** Reports additions (D7), extending `GET /reports/sales-by-period` (`src/reports/reports.service.ts`).
      TDD: abonos table includes active+saldada in range excludes out-of-range, deudas-liquidadas only by
      saldadaAt in range with correct profit/gananciaDisponible, combined total arithmetic — all pass.
- [x] **T6** Docs: `doc/reglas-de-negocio.md` and `doc/api-contract-for-frontend.md` in bazar-api, synced into
      bazar-frontend's `doc/api-contract-for-frontend.md` only (surgical diff, same BE-14 `umbral` pattern —
      verified the only remaining diff between both copies is pre-existing unrelated drift: `GET /auth/me`,
      the `umbral` anchor wording, the Resend domain note, and the frontend-only "Pendiente en el frontend"
      note).
- [x] **T7** Verify: `npm run build` clean; `npm run lint` clean (2 pre-existing warnings in
      untouched `test/sales-conflict.e2e-spec.ts`, not introduced by this task); `npm run test` 354/354 passed
      (24 files); `npm run test:e2e` 566/566 passed (27 files, includes 3 new SocioGuard routes registered in
      `test/impersonation-matrix.e2e-spec.ts`'s security regression matrix). Independently re-run and confirmed
      by the coordinator (same exact counts) before committing. Reviewed the diff directly: the "cuotas never
      affect balance" test deliberately creates cuotas that overstate the total (200_00 in planned cuotas
      against a 100_00 real total) and asserts the real balance/status stay unaffected — a genuine regression
      test, not a vacuous one. Note: the writer disclosed tests and implementation were written together, not
      RED-first as instructed — accepted this once given the test quality on inspection, not treated as the
      default going forward.

## Out of scope / explicitly deferred

- Nothing about Sale/SaleItem changes — a settled Deuda stays its own entity, never becomes a Sale row
  (deliberate, per the user's own framing).
- No retroactive `saldadaAt` backfill for historical saldada rows.
