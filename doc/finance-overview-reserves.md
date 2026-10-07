# Recorded finance overview

`GET /api/v1/finance/overview?from=2026-10-01&to=2026-10-02` returns a socio-only, server-confirmed view of recorded operating inputs in MXN minor units. It is NOT a cash balance, withdrawable profit or partner distribution calculation. Period-linked reserves are persisted and can be created/listed. Reserve cancellation HTTP endpoints and concurrency verification remain pending FR2; no edit/delete endpoint exists.

## Request and period

Use the existing bearer authentication and selected member/device headers. Both query parameters are required strict, real `YYYY-MM-DD` calendar dates (years 0001-9999). `from` must precede `to`; unknown parameters are rejected. Dates describe the half-open interval `[from,to)` in the existing fixed UTC-06 business timezone. Both instants are local midnight starts: the example spans `2026-10-01T06:00:00.000Z` to, excluding, `2026-10-02T06:00:00.000Z`. Shifts use date-only `workDate` rather than instant boundaries.

The read uses one callback-form Prisma `RepeatableRead` transaction. The existing injected tenant extension forwards transaction options, establishes connection-local RLS and preserves scoped model queries. No independent reads, array-form transaction or current product-cost lookup is used. Reversals are evaluated as of this server snapshot, not historically as of the period end. Existing receivedAt-based reports are unchanged.

## Response contract

All monetary fields and minutes are integer JSON numbers. Negative margins/results remain negative. Percentage is an unrounded number from 0 to 100, or null for no sale lines.

| Object          | Fields and meaning                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currency`      | `MXN`                                                                                                                                                                  |
| `period`        | `from`, `to`, UTC `fromInstant`/`toInstant`, `utcOffsetMinutes: -360`, `interval: "[from,to)"`                                                                         |
| `timeBasis`     | `sales`, `expenses`, `contributions`: `occurredAt`; `workShifts`: `workDate`; `reserves`: `exactPeriod`                                                                |
| `sales`         | `saleCount`, `salesMinor`, `recordedCostMinor`, `recordedGrossMarginMinor`                                                                                             |
| `costCoverage`  | `status: complete/partial`, `totalLineCount`, `knownCostLineCount`, `missingCostLineCount`, `missingCostUnitCount`, `salesWithoutCostMinor`, `knownCostLinePercentage` |
| `expenses`      | `operatingMinor`, `inventoryPurchasesMinor`                                                                                                                            |
| `contributions` | `amountMinor`, `count`                                                                                                                                                 |
| `workShifts`    | `shiftCount`, `knownMinutes`, `unknownDurationCount`; no monetary valuation                                                                                            |
| `reserves`      | `activeCount`, `plannedMinor`, `matching: "EXACT_PERIOD"`                                                                                                              |
| `result`        | `recordedOperatingResultMinor`, `potentiallyAvailableMinor`, `status: complete/partial`, `isCashBalance: false`, `isWithdrawableProfit: false`                         |
| `sync`          | `source: "SERVER_CONFIRMED"`, `localPendingIncluded: false`                                                                                                            |
| `warnings`      | Array of `{code, message}`; stable codes below, informational English messages                                                                                         |
| `generatedAt`   | UTC ISO timestamp generated for this response, not an offline synchronization watermark                                                                                |

### Recorded-input arithmetic

Only `completada` sales count. All completed sale totals contribute to revenue; only non-null `SaleItem.unitCostMinor * quantity` contributes to recorded sold-item cost. Zero cost is known. Null cost is unknown and never reconstructed from current products or inventory purchases. `salesWithoutCostMinor` sums recorded subtotals of unknown-cost lines; coverage counts lines, not products or units.

`recordedGrossMarginMinor = salesMinor - recordedCostMinor`.

`recordedOperatingResultMinor = recordedGrossMarginMinor - operatingMinor`.

`potentiallyAvailableMinor = recordedOperatingResultMinor - plannedMinor`. Only active reserves whose immutable `periodFrom` AND `periodTo` exactly equal the requested period contribute. Overlap, containment, neighboring periods, allocation and proration do not match. Reserve `occurredAt` is audit metadata, not a selection boundary. Planning reserves do not alter expenses, contributions, stock, cost coverage or recorded operating result. Cancellation facts are schema-ready and excluded when present; cancellation HTTP behavior is pending FR2.

Active expenses/contributions/shifts exclude originals with a reversal. Replacement facts count independently if active and in the period. Operating expenses reduce the result; inventory purchases and contributions are separate totals, not further deductions or income. Work shifts are nonmonetary: null minutes increase unknown duration count, not inferred duration or compensation.

A missing cost makes cost coverage and both downstream results `partial`. Otherwise they are `complete` for recorded inputs only. An empty period is complete with zero amounts and null coverage percentage, NEVER an assertion of accounting completeness. The browser must separately reconcile its durable pending queue; the API neither sees nor claims to know its pending records.

### Stable warning codes

| Code                              | When / caveat                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `MISSING_SALE_COST`               | At least one sold line has null recorded cost; margin and results are partial.                            |
| `SYNC_TIME_COST_NO_LOT_VALUATION` | Always: recorded cost is the server-processing snapshot, not a lot-based valuation at economic sale time. |
| `NOT_CASH_OR_WITHDRAWABLE_PROFIT` | Always: cash, commitments, capital recovery and compensation are not reconciled.                          |

BigInt arithmetic preserves exact products/sums before conversion. An output beyond JavaScript's safe integer range fails with HTTP 422 and code `FINANCE_OVERVIEW_OVERFLOW` rather than rounding, clamping or returning an unsafe number. Invalid legacy completed sales with null totals fail with `FINANCE_OVERVIEW_INVALID_RECORDED_SALE`; unsupported active expense natures fail with `FINANCE_OVERVIEW_INVALID_EXPENSE_NATURE` (also HTTP 422).

## Verification boundary

Focused DTO/service tests exercise period and arithmetic contracts. The HTTP suite covers guard contexts, tenant-isolated fixtures, occurredAt versus receivedAt, start/end boundaries, reversed inputs, and the tenant extension's actual transaction isolation/connection identity. Existing impersonation-matrix coverage includes the new route. Test configuration permits only the existing local `bazar_test` database; fixtures use unique contexts and targeted cleanup, never a reset/drop or email delivery. Current execution results and any environmental blocks are recorded in `odd/tasks/finance-overview-reserves.md`.

## Planned reserve create/list

Both endpoints require the existing socio authorization, selected active member and authorized device. Planning a reserve is NOT a payment, cash segregation, accrued expense, available cash guarantee or authority to distribute profit. Monetary values are MXN integer minor units.

### Create

`POST /api/v1/finance/reserves` accepts:

```json
{
  "id": "0199a600-0000-7000-8000-000000000001",
  "name": "Next bazaar rent buffer",
  "amountMinor": 5000,
  "currency": "MXN",
  "periodFrom": "2026-10-01",
  "periodTo": "2026-11-01",
  "note": "Awaiting the venue quote",
  "occurredAt": "2026-10-07T12:00:00Z",
  "createdByMemberId": "11111111-1111-4111-8111-111111111111",
  "deviceId": "22222222-2222-4222-8222-222222222222"
}
```

- `id` is a client-generated UUIDv7. Origin UUIDs must match the current selection. Server `contextId`/`createdByAccountId` cannot be supplied.
- Name is trimmed, required and 1-120 characters. Note is optional/null, trimmed and at most 1000 characters; an explicitly blank note remains an empty string. Amount is a JSON integer from 1 to 2147483647 (no string/boolean coercion). Currency defaults to MXN; other currencies/null are rejected.
- Both period dates are required real calendar dates, years 0001-9999, with `periodFrom < periodTo`; dates are stored as DATE and exposed as date-only strings. `occurredAt` is a required zoned ISO audit instant, normalized to UTC milliseconds.
- First create returns HTTP 201 with all normalized input fields plus server `contextId`, `createdByAccountId` and UTC `receivedAt`. Exact normalized retry from the same account returns HTTP 200 with that original immutable receipt, including after cancellation; it never recomputes an old response. Current authorization is still required for every request.
- A reused own-context ID with different normalized content or a different account returns 409. A global-ID collision inaccessible under tenant RLS returns generic 404, not another business's receipt. Name/note whitespace, UUID case, equivalent audit instants, omitted/explicit MXN and omitted/null notes normalize consistently for fingerprints.
- Inside the write transaction, active account (including member binding), active socio and authorized device are rechecked under SHARE locks. A tenant-scoped identity advisory lock serializes insert/replay. The stored fingerprint is not returned. No update/delete operation is provided.

### List

`GET /api/v1/finance/reserves?from=2026-10-01&to=2026-11-01&status=active&limit=20` returns `{items, nextCursor}`.

`from` and `to` are both optional but must be supplied together when filtering; they match the stored period EXACTLY, not overlap or audit time. Without both, all periods in this tenant are eligible. `status` is `active` (default) or `reversed`. `limit` defaults to 20, ranges from 1 to 100 and accepts only decimal digits in HTTP query strings (not hexadecimal, exponent, booleans, arrays or empty strings).

Items expose recorded fields with date-only period strings, `status` and a nullable `reversal` projection (`id`, `reserveId`, `reason`, UTC `occurredAt`/`receivedAt`, `createdByMemberId`, `createdByAccountId`, `deviceId`). Internal request fingerprints and immutable receipt storage are omitted. Reversal projection is schema-ready; creating cancellations through HTTP is pending FR2.

Pagination orders by server `receivedAt` descending, then UUID descending. Pass the opaque `nextCursor` unchanged; null means no further page. Cursor version and binding include this tenant, exact-period filters and status; a mismatched or malformed cursor returns 400. Changing page size is allowed. Cursors are pagination positions, not signed authorization tokens or durable offline snapshots; concurrent new inserts may require refreshing the first page.

### Storage and operational boundary

The additive migration creates `FinanceReserve` and `FinanceReserveReversal`, positive amount/MXN/calendar/name constraints, unique identities, one cancellation per reserve, composite tenant-aware RESTRICT audit/reference foreign keys, and ENABLE/FORCE tenant RLS on both tables. The tenant extension scopes both delegates. No existing fact is rewritten, no cash movement is created and no historical report is changed. Like existing finance facts, immutability is the API contract; raw privileged maintenance is not an edit API.

FR1 adds create/list and exact-period overview integration only. FR2 must implement cancellation audit/replay/double-cancellation behavior and concurrency checks before the feature is described as fully complete. Browser durable queue/local-pending projection/offline snapshots, compensation, distribution and capital reconciliation remain outside this backend-only scope.
