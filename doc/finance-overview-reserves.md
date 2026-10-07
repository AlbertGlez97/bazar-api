# Recorded finance overview

`GET /api/v1/finance/overview?from=2026-10-01&to=2026-10-02` returns a socio-only, server-confirmed view of recorded operating inputs in MXN minor units. It is NOT a cash balance, withdrawable profit or partner distribution calculation. Reserve persistence and reserve administration endpoints are pending FR1/FR2; this FO1 implementation explicitly returns zero planned reserves and `RESERVES_PENDING`.

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
| `reserves`      | Temporarily `activeCount: 0`, `plannedMinor: 0`, `matching: "EXACT_PERIOD"`                                                                                            |
| `result`        | `recordedOperatingResultMinor`, `potentiallyAvailableMinor`, `status: complete/partial`, `isCashBalance: false`, `isWithdrawableProfit: false`                         |
| `sync`          | `source: "SERVER_CONFIRMED"`, `localPendingIncluded: false`                                                                                                            |
| `warnings`      | Array of `{code, message}`; stable codes below, informational English messages                                                                                         |
| `generatedAt`   | UTC ISO timestamp generated for this response, not an offline synchronization watermark                                                                                |

### Recorded-input arithmetic

Only `completada` sales count. All completed sale totals contribute to revenue; only non-null `SaleItem.unitCostMinor * quantity` contributes to recorded sold-item cost. Zero cost is known. Null cost is unknown and never reconstructed from current products or inventory purchases. `salesWithoutCostMinor` sums recorded subtotals of unknown-cost lines; coverage counts lines, not products or units.

`recordedGrossMarginMinor = salesMinor - recordedCostMinor`.

`recordedOperatingResultMinor = recordedGrossMarginMinor - operatingMinor`.

In FO1, `potentiallyAvailableMinor = recordedOperatingResultMinor` because reserves are pending and temporarily zero. In the reserved contract, active reserves subtract only when their immutable `from` AND `to` exactly equal the requested period. Overlap, containment, neighboring periods, allocation and proration do not match. Exact-period persistence and reversal integration are not implemented in FO1.

Active expenses/contributions/shifts exclude originals with a reversal. Replacement facts count independently if active and in the period. Operating expenses reduce the result; inventory purchases and contributions are separate totals, not further deductions or income. Work shifts are nonmonetary: null minutes increase unknown duration count, not inferred duration or compensation.

A missing cost makes cost coverage and both downstream results `partial`. Otherwise they are `complete` for recorded inputs only. An empty period is complete with zero amounts and null coverage percentage, NEVER an assertion of accounting completeness. The browser must separately reconcile its durable pending queue; the API neither sees nor claims to know its pending records.

### Stable warning codes

| Code                              | When / caveat                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `MISSING_SALE_COST`               | At least one sold line has null recorded cost; margin and results are partial.                            |
| `SYNC_TIME_COST_NO_LOT_VALUATION` | Always: recorded cost is the server-processing snapshot, not a lot-based valuation at economic sale time. |
| `NOT_CASH_OR_WITHDRAWABLE_PROFIT` | Always: cash, commitments, capital recovery and compensation are not reconciled.                          |
| `RESERVES_PENDING`                | FO1: reserve endpoints and persistence are pending; zero reserves are temporary.                          |

BigInt arithmetic preserves exact products/sums before conversion. An output beyond JavaScript's safe integer range fails with HTTP 422 and code `FINANCE_OVERVIEW_OVERFLOW` rather than rounding, clamping or returning an unsafe number. Invalid legacy completed sales with null totals fail with `FINANCE_OVERVIEW_INVALID_RECORDED_SALE`; unsupported active expense natures fail with `FINANCE_OVERVIEW_INVALID_EXPENSE_NATURE` (also HTTP 422).

## Verification boundary

Focused DTO/service tests exercise period and arithmetic contracts. The HTTP suite covers guard contexts, tenant-isolated fixtures, occurredAt versus receivedAt, start/end boundaries, reversed inputs, and the tenant extension's actual transaction isolation/connection identity. Existing impersonation-matrix coverage includes the new route. Test configuration permits only the existing local `bazar_test` database; fixtures use unique contexts and targeted cleanup, never a reset/drop or email delivery. Current execution results and any environmental blocks are recorded in `odd/tasks/finance-overview-reserves.md`.
