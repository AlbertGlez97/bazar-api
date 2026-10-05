# Business expenses API

An expense records money spent for the business: either an operating expense or an inventory purchase, who paid it and whether the money came from the business or from a person's own pocket. It is a financial fact only. It never changes stock, lots, product cost (`purchaseCost`) or sales, a reversal is not a cash movement, and nothing here produces income.

## Rules

- All endpoints require bearer authentication, an authorized device and an active selected socio (`SocioGuard`). Collaborators receive 403 on every endpoint.
- The server derives business and account from authentication; a client-sent `contextId` is rejected (400).
- The payer (`paidByMemberId`) must be an **active member of the same business, any role**. Another business or an inactive member returns 403. The payer and the recorder (`createdByMemberId`) are independent.
- `createdByMemberId` and `deviceId` must match the `x-member-id` / `x-device-id` headers (403 otherwise), so an offline operation keeps its original origin.
- No PATCH or DELETE exist. Corrections are reversals.

## Fields and catalogs

| Field | Rule |
| --- | --- |
| `id` | Client-generated UUID v7 |
| `amountMinor` | Positive integer MXN cents, at most 2147483647 |
| `occurredAt` | ISO instant with explicit timezone, at most three fractional-second digits |
| `nature` | `OPERATING_EXPENSE` or `INVENTORY_PURCHASE` |
| `category` | `transport`, `fuel`, `food`, `bazaar_rent`, `storage`, `advertising`, `utilities`, `packaging`, `maintenance`, `operating_payment`, `other`, `inventory` |
| `description` | Required, trimmed by the server, 1 to 280 characters after trimming |
| `paidByMemberId` | UUID of the payer |
| `fundsSource` | `BUSINESS` or `PERSONAL` |
| `createdByMemberId`, `deviceId` | UUIDs of the original actor and device |

Pairing rule: `INVENTORY_PURCHASE` requires category `inventory`, and `inventory` is only valid with `INVENTORY_PURCHASE` (400 otherwise, also inside a replacement). The category catalog lives in code, not in a database enum; the pairing is also enforced by a database CHECK.

## Create

`POST /api/v1/finance/expenses`

```json
{
  "id": "0199aae0-1000-7000-8000-000000000001",
  "amountMinor": 12500,
  "occurredAt": "2026-10-05T10:00:00-06:00",
  "nature": "OPERATING_EXPENSE",
  "category": "transport",
  "description": "Taxi to the bazaar",
  "paidByMemberId": "0199aae0-1000-7000-8000-000000000002",
  "fundsSource": "BUSINESS",
  "createdByMemberId": "0199aae0-1000-7000-8000-000000000003",
  "deviceId": "0199aae0-1000-7000-8000-000000000004"
}
```

Responses:

- `201` first creation, `200` exact replay (same normalized content and account) returning the immutable original receipt, `409` same `id` with different content (or an id owned by another business).
- Replay normalizes case of UUIDs, UTC instant and trimmed description, so an equivalent retry is an exact replay.
- Concurrent identical submissions create exactly one row (one `201`, the rest `200`).

Receipt (the body of 201 and 200):

```json
{
  "id": "0199aae0-1000-7000-8000-000000000001",
  "amountMinor": 12500,
  "occurredAt": "2026-10-05T16:00:00.000Z",
  "nature": "OPERATING_EXPENSE",
  "category": "transport",
  "description": "Taxi to the bazaar",
  "paidByMemberId": "0199aae0-1000-7000-8000-000000000002",
  "fundsSource": "BUSINESS",
  "createdByMemberId": "0199aae0-1000-7000-8000-000000000003",
  "deviceId": "0199aae0-1000-7000-8000-000000000004",
  "contextId": "<business id>",
  "currency": "MXN",
  "createdByAccountId": "<account uuid>",
  "receivedAt": "2026-10-05T16:00:01.123Z"
}
```

Instants in receipts are UTC (`toISOString`).

## List

`GET /api/v1/finance/expenses?from&to&paidByMemberId&nature&category&limit=20&cursor`

All filters are optional. `from` is inclusive and `to` exclusive over the economic `occurredAt` (not reception). `nature` and `category` must be catalog values and `paidByMemberId` a UUID, otherwise 400. `from >= to` returns 400, as does a malformed cursor. Order is descending `(occurredAt, id)`; `limit` is 1 to 100.

Response `{ "items": [...], "nextCursor": string | null }`. List item:

```json
{
  "id": "0199aae0-1000-7000-8000-000000000001",
  "contextId": "<business id>",
  "amountMinor": 12500,
  "currency": "MXN",
  "occurredAt": "2026-10-05T16:00:00.000Z",
  "nature": "OPERATING_EXPENSE",
  "category": "transport",
  "description": "Taxi to the bazaar",
  "paidByMemberId": "0199aae0-1000-7000-8000-000000000002",
  "fundsSource": "BUSINESS",
  "createdByMemberId": "0199aae0-1000-7000-8000-000000000003",
  "createdByAccountId": "<account uuid>",
  "deviceId": "0199aae0-1000-7000-8000-000000000004",
  "receivedAt": "2026-10-05T16:00:01.123Z",
  "paidByMember": { "id": "0199aae0-1000-7000-8000-000000000002", "name": "Ana", "active": true },
  "reversal": null
}
```

`reversal` is `null` or:

```json
{
  "id": "<reversal uuid>",
  "expenseId": "<expense uuid>",
  "replacementExpenseId": "<uuid or null>",
  "reason": "Incorrect amount",
  "occurredAt": "2026-10-05T12:00:00.000Z",
  "receivedAt": "2026-10-05T12:00:02.000Z",
  "createdByMemberId": "<uuid>",
  "deviceId": "<uuid>"
}
```

Internal fingerprint and stored receipt fields are not exposed. Reversed expenses stay in the list (with `reversal` set) so the history is auditable.

## Summary

`GET /api/v1/finance/expenses/summary?from&to`

`from` and `to` are optional with the same semantics as the list (`from >= to` returns 400). Response, all integers in MXN cents:

```json
{ "operatingMinor": 1200, "inventoryMinor": 35000, "personalMinor": 30200, "businessMinor": 6000 }
```

- `operatingMinor` sums `OPERATING_EXPENSE`; `inventoryMinor` sums `INVENTORY_PURCHASE`.
- `businessMinor` sums `fundsSource = BUSINESS`; `personalMinor` sums `PERSONAL`.
- Operating plus inventory equals business plus personal (two views over the same set).
- Expenses that have a reversal are excluded. A replacement created by a correction is a normal expense and is counted. An empty period returns all zeros.

## Reverse (correct) an expense

`POST /api/v1/finance/expenses/:id/reversals`

```json
{
  "id": "0199aae0-2000-7000-8000-000000000001",
  "createdByMemberId": "0199aae0-1000-7000-8000-000000000003",
  "deviceId": "0199aae0-1000-7000-8000-000000000004",
  "occurredAt": "2026-10-05T12:00:00Z",
  "reason": "Incorrect amount",
  "replacement": { "...full create body, with its own UUID v7 id...": "" }
}
```

Omit `replacement` for a simple annulment. `reason` needs non-whitespace text (maximum 1000 characters). Reversal, original and replacement ids must differ (400). The replacement origin must match the reversal origin and follows every create rule, including the payer and nature/category checks.

Responses: `201` created, `200` exact replay of the same reversal id, `409` different content for that reversal id, an expense that is already reversed, or an existing replacement id, `404` expense not found in your business (a foreign or unknown id is indistinguishable). A failing replacement rolls back the whole correction.

Reversal receipt:

```json
{
  "id": "<reversal uuid>",
  "expenseId": "<expense uuid>",
  "createdByMemberId": "<uuid>",
  "deviceId": "<uuid>",
  "occurredAt": "2026-10-05T12:00:00.000Z",
  "reason": "Incorrect amount",
  "contextId": "<business id>",
  "createdByAccountId": "<account uuid>",
  "receivedAt": "2026-10-05T12:00:02.000Z",
  "replacementExpenseId": "<uuid or null>",
  "original": { "...the original expense receipt..." },
  "replacement": { "...the replacement expense receipt, or null..." }
}
```

A correction-created expense cannot be posted standalone: its UUID is bound to the reversal. Replay the reversal to reconcile an uncertain correction. Original amounts are never modified. A reversal is a correction, not a refund: it moves no money and creates no income.

## Concurrency and isolation

Writes run in one transaction with ordered advisory locks per identity, a row lock on the target expense and SHARE locks on the actor, device and payer, so there is exactly one winner for a concurrent reversal. `Expense` and `ExpenseReversal` are tenant scoped (Prisma tenant extension) and protected by forced Row Level Security; foreign keys are `ON DELETE RESTRICT`.

## Offline integration

Persist the UUID and the unchanged payload locally before sending, keep the original member and device origin without tokens, replay with that origin and reconcile pending and confirmed records by UUID. Do not reuse the sales operation queue.

## Deployment boundary

The additive migration is `20261005090000_finance_expenses`. Production migration application is not part of this change.
