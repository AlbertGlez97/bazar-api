# Finance distribution payments (Phase 6)

Phase 6 records money that was REALLY PAID against a distribution agreement. La Marchanta does not move money: it records and documents what was agreed, what was actually paid and what remains pending. "Agreed" is never "paid".

## Mini-RFC

### 1. Data model
Two new immutable tables (`DistributionPayment`, `DistributionPaymentReversal`), both tenant-scoped (`contextId`, composite FKs, ENABLE + FORCE RLS, `tenant_isolation` policy, registered in `TENANT_SCOPED_MODELS`), plus one unique index on an existing table.

- `DistributionPayment`: `id` (UUIDv7, client supplied), `contextId`, `agreementId`, `participantMemberId`, `amountMinor` (Int, CHECK > 0 and <= MAX_MINOR_UNITS), `currency` (copied from the agreement, CHAR(3)), `occurredAt` (timestamptz, when the real payment happened), `note` (nullable, max 1000), `createdByMemberId`, `createdByAccountId`, `deviceId`, `receivedAt` (server clock), `requestFingerprint`, `creationResponse` (JSONB, the immutable receipt core). Composite FK `(agreementId, participantMemberId, contextId)` to `DistributionAgreementParticipant`, so a payment can only belong to a participant frozen in that agreement. Not a FK to a live Member for the payee.
- `DistributionPaymentReversal`: `id` (UUIDv7), `contextId`, `paymentId` (UNIQUE: one reversal per payment), `reason` (1..1000), `occurredAt`, `receivedAt`, `createdBy*`, `deviceId`, `requestFingerprint`, `creationResponse`.
- Existing `DistributionAgreementParticipant` gets `@@unique([agreementId, memberId, contextId])` (the FK target). It is an index only; the table stays immutable.
- BEFORE UPDATE OR DELETE triggers reject any change on both new tables (same pattern as agreements).
- No payment method column (no real need yet), no folio, no counter, no stored `remainingMinor`.

### 2. Source of truth for the balance
- Agreed: `DistributionAgreementParticipant.totalMinor` (frozen).
- Paid: `SUM(amountMinor)` of payments of that participant WITHOUT a reversal row.
- Pending: agreed - paid. Always computed, never persisted.

### 3. Derived status (never stored)
- Participant: `UNPAID` (paid = 0), `PARTIALLY_PAID` (0 < paid < agreed), `PAID` (paid = agreed). A participant with agreed = 0 has nothing to pay: `NOT_DUE`, and payments against them are rejected.
- Agreement `paymentStatus`: computed over participants with agreed > 0; all PAID gives `PAID`, all UNPAID gives `UNPAID`, otherwise `PARTIALLY_PAID`; no participant due gives `NOT_DUE`.
- Independent of `agreement.status` (`active` or `voided`). A voided agreement can legitimately be `PARTIALLY_PAID`.

### 4. Anti-overpayment
Inside the transaction, after taking the lock (point 5), compute `paid` from committed active payments and reject when `paid + amount > agreed` with 422 `FINANCE_PAYMENT_EXCEEDS_PENDING`, returning `agreedMinor`, `paidMinor`, `pendingMinor`. Never truncate. Exactly the pending amount is accepted. A database CHECK enforces `amountMinor > 0`. The cumulative cap cannot be a CHECK, so it is enforced by serialization.

### 5. Concurrency
- Create: one transaction (READ COMMITTED default, re-read under lock). Lock order: advisory lock by payment `id` (idempotency/replay), then `SELECT ... FOR SHARE` on the agreement row with the voided state re-read under it (a concurrent void takes `FOR UPDATE` on the agreement, so they serialize; the void path takes no participant locks, so there is no cycle), then `SELECT ... FOR UPDATE` on the participant row (serializes all payments and reversals of that participant). The balance is computed only after the participant lock is held, so two concurrent payments of 800 against 1000 pending serialize and the second is rejected.
- Reversal: advisory lock by reversal `id`, read payment to find the participant, `FOR UPDATE` on the participant row, then `FOR UPDATE` on the payment. Same lock order as create (participant first).
- Hard cap proof is by test: a real concurrent race on one participant and a database check that active paid <= agreed.

### 6. Reversals
Body: `{ id UUIDv7, reason 1..1000 trimmed nonblank, occurredAt zoned ISO (max 3 fractional digits), createdByMemberId, deviceId }`. Errors: 404 unknown/foreign payment, 409 `FINANCE_PAYMENT_ID_CONFLICT` (reversal id reused with different content or for a different payment), 409 `FINANCE_PAYMENT_ALREADY_VOIDED`, 422 `FINANCE_PAYMENT_REVERSAL_TIME_INVALID`.
Original stays immutable. `POST .../reversals` with reason inserts a `DistributionPaymentReversal`; the payment then counts as voided and no longer adds to paid. Correction is two steps: reverse, then create the right payment (no atomic replacement in the MVP). One reversal per payment: second attempt 409 `FINANCE_PAYMENT_ALREADY_VOIDED`. A reversal is allowed even when the agreement is voided (it only fixes a mistaken record). Reversal `occurredAt` must be >= the payment `occurredAt` and <= server `receivedAt`.

### 7. Permissions
`SocioGuard` on every route: only an active socio on an authorized device can create, list, read and reverse. Collaborators get 403 everywhere in Phase 6. No new permission concepts.

### 8. Dates
Clock skew: the upper bound is the server clock with no tolerance (same as agreements). A device clock ahead of the server gets 422 `FINANCE_PAYMENT_TIME_INVALID`; the frontend must handle it by asking the user to pick an earlier time.
`occurredAt` is the real payment time, supplied by the client but bounded by the server: it must be >= the agreement `occurredAt` and <= the server clock captured at insertion (no future, no tolerance). Otherwise 422 `FINANCE_PAYMENT_TIME_INVALID`. Replay is resolved (under the id advisory lock) BEFORE every business check (voided, nothing agreed, time, overpayment), so a retry after a committed exact-pending payment returns 200 (not 422) and a retry after a later void returns 200 (not 409); the same holds for reversals. The browser clock is never the upper bound.

### 9. Voided agreement
Creating a payment against a voided agreement: 409 `FINANCE_PAYMENT_AGREEMENT_VOIDED`. Existing payments stay listed and readable. Voiding an agreement never touches payments. The agreement void endpoint is unchanged; the UI warns when payments exist.

### 10. Impact on the overview
None. A distribution payment is not an operating expense: `Expense`, `operatingResult`, margin, sales, contributions, work shifts, reserves and the agreement snapshot are not modified, and `potentiallyAvailableMinor` is NOT adjusted (there is no real cash balance or reconciliation yet). Payments are shown separately. Documented as future work.

### 11. Endpoints (all under `/api/v1`)
- `POST /finance/distribution-agreements/:agreementId/payments`: 201 first, 200 identical replay, 409 same id with different content or account/agreement.
- `GET /finance/distribution-agreements/:agreementId/payments`: all payments of the agreement ordered by `occurredAt` desc, `receivedAt` desc, `id` desc, plus `paymentSummary`. Intentionally not paginated (bounded by participants x corrections); growth with repeated corrections is an accepted, documented limitation.
- `GET /finance/distribution-payments/:id`: one payment.
- `POST /finance/distribution-payments/:id/reversals`: 201 / 200 replay / 409.
- `GET /finance/distribution-agreements/:id` (existing) gains `paymentSummary`.

Create body (strict, unknown fields rejected): `id`, `participantMemberId`, `amountMinor` (integer > 0), `occurredAt` (zoned ISO), `note?`, `createdByMemberId`, `deviceId`. The server derives agreed amount, balance, context, account, currency and the participant name.

### 12. Response shape for the frontend
Payment: `id`, `contextId`, `agreementId`, `participantMemberId`, `participantName` (frozen from the agreement), `amountMinor`, `currency`, `occurredAt`, `receivedAt`, `note`, `createdBy {memberId, name, accountId, deviceId}`, `status` (`active` | `voided`), `reversal` (null or `{id, reason, occurredAt, receivedAt, createdBy...}`). The create/reversal receipt also returns the live `participantSummary` and `paymentSummary`.
`paymentSummary`: `{ status, agreedMinor, paidMinor, pendingMinor, hasPayments, paymentCount, activePaymentCount, participants: [{ memberId, memberName, agreedMinor, paidMinor, pendingMinor, status }] }`. `hasPayments` is inside `paymentSummary` and is true when ANY payment row (active or voided) exists for the agreement (the UI warns before voiding).
Errors: 400 validation; 401/403; 404 unknown/foreign agreement, payment or non-participant (same 404); 409 `FINANCE_PAYMENT_ID_CONFLICT` (also when the payment or reversal id exists in ANOTHER tenant: invisible under RLS, the primary key insert is mapped to this code), `FINANCE_PAYMENT_AGREEMENT_VOIDED`, `FINANCE_PAYMENT_ALREADY_VOIDED`; 422 `FINANCE_PAYMENT_EXCEEDS_PENDING`, `FINANCE_PAYMENT_TIME_INVALID`, `FINANCE_PAYMENT_NOTHING_AGREED`, `FINANCE_PAYMENT_REVERSAL_TIME_INVALID`.

### 13. Risks
- Cumulative cap enforced by locking, not by a database constraint: mitigated by the participant row lock plus a real concurrency test.
- Lock ordering deadlocks between create and reversal: same order (participant first); no retry loop needed because waiters queue.
- New unique index on `DistributionAgreementParticipant` (an immutable table) requires a migration over existing data: harmless (the primary key columns `(agreementId, memberId)` are already unique, so `(agreementId, memberId, contextId)` is too).
- Production DB gets a new migration only when the operator deploys; not done here.
- Money is real: payments cannot be edited or deleted, only reversed.

## Tasks
- [x] P6-B1 Prisma models, migration (FORCE RLS, CHECKs, triggers, composite FKs), tenant extension, from-scratch `migrate deploy` proof (c9c2187, identifier alignment fix b24e439)
- [x] P6-B2 DTOs and service (create, replay, overpayment, concurrency, reversal, summary, list) (05b1308)
- [x] P6-B3 Controller endpoints and agreement detail `paymentSummary` (ec3973d)
- [x] P6-B4 Backend tests (unit, e2e, concurrency, tenant/RLS, overview regression) (bbc156c, b24e439)
- [x] P6-B5 Backend docs (`docs(finance): document distribution payments`)
- [ ] P6-F1 Frontend contract, service, store (online only)
- [ ] P6-F2 Agreement detail Pagos section, register payment, reversal, states
- [ ] P6-F3 Help, docs, tests (offline blocked, permissions, session)
- [ ] P6-V1 Real integrated validation (cases, concurrency, overview, offline, responsive, a11y)
- [ ] P6-V2 Full suites, docs, merge to main, push

## Route
Delegated direct: one writer per repo (backend first, then frontend against the real contract); parent runs real integration and final verification.

## Progress / evidence
Backend (branch `feat/finance-distribution-payments`), verified in the foreground:
- `npm test`: 42 files, 722 tests passed (baseline 701).
- `npm run test:e2e`: 35 files, 970 tests passed (baseline 913 in 34 files). New: `test/finance-distribution-payments.e2e-spec.ts` (33 tests), 4 routes in the impersonation matrix.
- `npm run lint`: 0 errors, 2 pre-existing warnings in `test/sales-conflict.e2e-spec.ts`. `npm run build`: clean.
- From-scratch proof: `prisma migrate deploy` on a temporary empty Postgres 16 container applied 27 migrations; `prisma migrate diff` reported no difference with the schema; both tables have ENABLE + FORCE RLS, the `tenant_isolation` policy, the immutability triggers, the named CHECKs and the restrictive composite FKs. Container removed afterwards.
- Concurrency proof: 800 vs 800 against 1000 pending (3 rounds), 12 parallel of 300 (exactly 3 accepted), payment racing a reversal, two reversals of one payment (201 + 409), payment racing an agreement void (5 rounds). Mutation check: removing the participant `FOR UPDATE` makes the 800/800 and N-parallel tests fail.
- RED evidence: the summary unit spec was run before `finance-payments.summary.ts` existed and failed (module missing). The DTO spec and the e2e suite were written after the implementation (no RED run); the race tests were validated by the mutation check above.
- Deviation/clarification: `FinanceAgreementsService.authorize` and `assertOrigin` became public so the payments service reuses them; the agreement detail runs in a transaction to compute `paymentSummary`; the existing agreements e2e tests now strip `paymentSummary` when comparing the detail with the immutable receipt.
