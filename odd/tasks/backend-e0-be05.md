# BE-05: Multi-item cash sale

Implement `POST /sales` (multi-item, cash-only) and `GET /sales/:id`, with server-authoritative pricing, whole-sale atomicity and stock discounting by product `tipo`. TDD active for this delivery: tests were written alongside/before the implementation to describe each rule; **no command was executed this session** (no `npm test`, `test:e2e`, `build`, `lint`, `prisma` commands, no Docker). Verification is deferred to manual execution on another machine.

## Scope and decisions (approved this session)
- In-person, cash-only sale for a physical bazaar; no e-commerce/online-payment concerns.
- Contract: `POST /sales` receives `{ id, memberId, deviceId, occurredAt, currency, cashReceivedMinor, items: [{ productId, quantity, unitPriceMinor? }] }`; `GET /sales/:id` returns the persisted sale with its items.
- Price is always the server's current `Product.unitPriceMinor`; the client's `unitPriceMinor` per item is optional and ignored for calculation (kept only for client-side traceability).
- Insufficient cash (`cashReceivedMinor < total`) rejects the whole sale with 400. No fiado/apartado (deferred payment) here — out of scope, future concept.
- Insufficient stock on any single item rejects the whole sale with 400; no partial sale.
- Atomicity: stock validation/discount, total/change calculation and Sale+SaleItem persistence occur inside one Prisma transaction (`$transaction`), with the same row-locking (`FOR UPDATE`) pattern already used by `ProductsService.mutate`. Any failure rolls back everything, including earlier items in the same request.
- Stock discount by `tipo`: `unica` goes 1→0 (quantity above available stock, e.g. 2, is rejected as insufficient stock); `cantidad` subtracts `quantity`. Items are processed sequentially (not `Promise.all`) inside the transaction so repeated `productId` lines in the same sale see each other's decrements.
- Authorization: reuses the existing BE-03 `ContextGuard` (bearer JWT + `x-member-id`/`x-device-id` headers, validated against the account's `contextId`). Any `Member` (`socio` or `colaborador`) may register a sale — no `SocioGuard` restriction. `GET /sales/:id` only requires `AuthGuard` (read scope), matching the products list/audit endpoints.
- The body's `memberId`/`deviceId` (needed for the offline-generated sale identity/payload) must match the header-selected `req.selection`; a mismatch is rejected with 403. This keeps the literal BE-05 contract while not trusting client-declared attribution over the already-authorized selection.
- Explicitly out of scope (BE-06): idempotency on duplicate/retried `id`, concurrent-resend conflict resolution, and the "last piece" policy for concurrent offline sales. The `Sale.id` primary key is already unique (from BE-02); what happens when the same id arrives twice is intentionally left unhandled here (will likely surface as an unhandled unique-constraint error until BE-06).
- No schema/migration changes: BE-02's `Sale`/`SaleItem` models already had every field this contract needs (`unitPriceMinor` rename on `Product` already landed in BE-04). `Sale` has no own `contextId`; context scoping for `GET /sales/:id` joins through `member.contextId`, consistent with how `Sale`/`SaleItem` already relate to `Member`/`Device`.
- Money: reused `src/common/money.ts` (`toDinero`/`toMinorUnits`) plus `add`/`subtract`/`multiply` imported directly from `dinero.js`, matching the existing pattern in `money.spec.ts`. `currency` is restricted to `'MXN'` at the DTO level since the money helpers only support MXN.
- Added `MAX_ITEM_QUANTITY = 100_000` as a sanity bound on `quantity` (not a business rule — a defensive limit against malformed/abusive payloads).

## Tasks
- [x] BE05-1: `CreateSaleItemDto`/`CreateSaleDto` with class-validator (non-empty items, positive integer quantity, ISO-8601 `occurredAt`, `MXN`-only currency, nonnegative cents).
- [x] BE05-2: `SalesService.create` — transactional, row-locked, server-priced, whole-or-nothing stock discount, cash/change calculation.
- [x] BE05-3: `SalesService.findOne` / `GET /sales/:id`, context-scoped through `member.contextId`.
- [x] BE05-4: `SalesController`, `SalesModule`, wired into `AppModule`.
- [x] BE05-5: `test/sales.e2e-spec.ts` covering unica 1→0, cantidad discount, multi-item totals with ignored client price, insufficient cash, insufficient stock (partial-item and whole-sale rollback), mid-sale nonexistent/foreign-context product rollback, attribution mismatch, malformed input, auth/authorization, context isolation on `GET`, and an injected mid-transaction persistence failure (mirrors the existing `ProductsService` rollback test style).
- [ ] BE05-6: Independent verification (run `prisma validate`/`generate`, unit+e2e tests, build, lint) on another machine, since this session must not execute anything.

## Checks (not run this session — pending manual verification)
Expected commands for the next verification pass: `npx prisma validate`, `npx prisma generate`, `npm test`, `npm run test:e2e`, `npm run build`, `npm run lint`. No migration is expected to be required (schema unchanged), but `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` should still be checked for drift before trusting a green run.

## Limitations / explicit non-goals
- Duplicate/resubmitted `Sale.id` handling, concurrent-resend reconciliation and the "last piece" conflict policy are BE-06, not implemented here.
- No fiado/apartado, discounts, cancellations, QR, or payment methods other than cash.
- `Sale`/`SaleItem` still lack a denormalized `contextId`; scoping relies on the `Member` relation, matching the current schema rather than introducing an unrelated schema change.
- No command was executed to confirm the tests pass; correctness is a stated assumption based on manual review of the code and of the BE-03/BE-04 patterns it reuses.
