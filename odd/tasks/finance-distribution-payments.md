# Finance distribution payments (Phase 6, backend)

Phase 6 records money that was REALLY PAID against a distribution agreement. La Marchanta does not move money: it records and documents what was agreed, what was actually paid and what remains pending. "Agreed" is never "paid".

## Mini-RFC

### 1. Data model
Three new immutable tables, all tenant-scoped (`contextId`, composite FKs, ENABLE + FORCE RLS, `tenant_isolation` policy, registered in `TENANT_SCOPED_MODELS`), plus one unique index on an existing table.

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
- Create: one transaction (READ COMMITTED default, re-read under lock). Lock order: advisory lock by payment `id` (idempotency/replay), then `SELECT ... FOR UPDATE` on the participant row (serializes all payments and reversals of that participant). The balance is computed only after the participant lock is held, so two concurrent payments of 800 against 1000 pending serialize and the second is rejected.
- Reversal: advisory lock by reversal `id`, read payment to find the participant, `FOR UPDATE` on the participant row, then `FOR UPDATE` on the payment. Same lock order as create (participant first).
- Hard cap proof is by test: a real concurrent race on one participant and a database check that active paid <= agreed.

### 6. Reversals
Original stays immutable. `POST .../reversals` with reason inserts a `DistributionPaymentReversal`; the payment then counts as voided and no longer adds to paid. Correction is two steps: reverse, then create the right payment (no atomic replacement in the MVP). One reversal per payment: second attempt 409 `FINANCE_PAYMENT_ALREADY_VOIDED`. A reversal is allowed even when the agreement is voided (it only fixes a mistaken record). Reversal `occurredAt` must be >= the payment `occurredAt` and <= server `receivedAt`.

### 7. Permissions
`SocioGuard` on every route: only an active socio on an authorized device can create, list, read and reverse. Collaborators get 403 everywhere in Phase 6. No new permission concepts.

### 8. Dates
`occurredAt` is the real payment time, supplied by the client but bounded by the server: it must be >= the agreement `occurredAt` and <= the server clock captured at insertion (no future, no tolerance). Otherwise 422 `FINANCE_PAYMENT_TIME_INVALID`. Replay is resolved before the time check, so an accepted retry stays valid. The browser clock is never the upper bound.

### 9. Voided agreement
Creating a payment against a voided agreement: 409 `FINANCE_PAYMENT_AGREEMENT_VOIDED`. Existing payments stay listed and readable. Voiding an agreement never touches payments. The agreement void endpoint is unchanged; the UI warns when payments exist.

### 10. Impact on the overview
None. A distribution payment is not an operating expense: `Expense`, `operatingResult`, margin, sales, contributions, work shifts, reserves and the agreement snapshot are not modified, and `potentiallyAvailableMinor` is NOT adjusted (there is no real cash balance or reconciliation yet). Payments are shown separately. Documented as future work.

### 11. Endpoints (all under `/api/v1`)
- `POST /finance/distribution-agreements/:agreementId/payments`: 201 first, 200 identical replay, 409 same id with different content or account/agreement.
- `GET /finance/distribution-agreements/:agreementId/payments`: all payments of the agreement (newest first) plus `paymentSummary`. Not paginated (bounded by participants x corrections).
- `GET /finance/distribution-payments/:id`: one payment.
- `POST /finance/distribution-payments/:id/reversals`: 201 / 200 replay / 409.
- `GET /finance/distribution-agreements/:id` (existing) gains `paymentSummary`.

Create body (strict, unknown fields rejected): `id`, `participantMemberId`, `amountMinor` (integer > 0), `occurredAt` (zoned ISO), `note?`, `createdByMemberId`, `deviceId`. The server derives agreed amount, balance, context, account, currency and the participant name.

### 12. Response shape for the frontend
Payment: `id`, `contextId`, `agreementId`, `participantMemberId`, `participantName` (frozen from the agreement), `amountMinor`, `currency`, `occurredAt`, `receivedAt`, `note`, `createdBy {memberId, name, accountId, deviceId}`, `status` (`active` | `voided`), `reversal` (null or `{id, reason, occurredAt, receivedAt, createdBy...}`). The create/reversal receipt also returns the live `participantSummary` and `paymentSummary`.
`paymentSummary`: `{ status, agreedMinor, paidMinor, pendingMinor, participants: [{ memberId, memberName, agreedMinor, paidMinor, pendingMinor, status }] }`, plus `hasPayments` for the voiding warning.
Errors: 400 validation; 401/403; 404 unknown/foreign agreement, payment or non-participant (same 404); 409 `FINANCE_PAYMENT_ID_CONFLICT`, `FINANCE_PAYMENT_AGREEMENT_VOIDED`, `FINANCE_PAYMENT_ALREADY_VOIDED`; 422 `FINANCE_PAYMENT_EXCEEDS_PENDING`, `FINANCE_PAYMENT_TIME_INVALID`, `FINANCE_PAYMENT_NOTHING_AGREED`, `FINANCE_PAYMENT_REVERSAL_TIME_INVALID`.

### 13. Risks
- Cumulative cap enforced by locking, not by a database constraint: mitigated by the participant row lock plus a real concurrency test.
- Lock ordering deadlocks between create and reversal: same order (participant first); no retry loop needed because waiters queue.
- New unique index on an immutable table requires a migration over existing data: harmless (the PK is already unique on a subset).
- Production DB gets a new migration only when the operator deploys; not done here.
- Money is real: payments cannot be edited or deleted, only reversed.

## Tasks
- [ ] P6-B1 Prisma models, migration (FORCE RLS, CHECKs, triggers, composite FKs), tenant extension, from-scratch `migrate deploy` proof
- [ ] P6-B2 DTOs and service (create, replay, overpayment, concurrency, reversal, summary, list)
- [ ] P6-B3 Controller endpoints and agreement detail `paymentSummary`
- [ ] P6-B4 Backend tests (unit, e2e, concurrency, tenant/RLS, overview regression)
- [ ] P6-B5 Backend docs
- [ ] P6-F1 Frontend contract, service, store (online only)
- [ ] P6-F2 Agreement detail Pagos section, register payment, reversal, states
- [ ] P6-F3 Help, docs, tests (offline blocked, permissions, session)
- [ ] P6-V1 Real integrated validation (cases, concurrency, overview, offline, responsive, a11y)
- [ ] P6-V2 Full suites, docs, merge to main, push

## Route
Delegated direct: one writer per repo (backend first, then frontend against the real contract); parent runs real integration and final verification.

## Progress / evidence
(pending)
