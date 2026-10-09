# Finance distribution simulator

`POST /api/v1/finance/distribution-simulations` is a socio-only, pure calculation. It answers: "if we distributed this amount of the period's potentially available money using this rule, how much would each member get?" It is a simulation: nothing is persisted, no migration or table exists for it, and nothing it returns is a payment, withdrawal, debt or obligation.

## What it does NOT do

- It does not save, approve, schedule or pay anything. The response says `simulation: true` and `persisted: false`, and repeated calls with the same data return identical bodies.
- Persisting an accepted simulation is a separate, explicit step: see [finance-distribution-agreements.md](finance-distribution-agreements.md). The simulator itself stays pure.
- It does not create obligations, member balances, withdrawals, capital recovery, taxes or compensation records.
- Capital contributions never influence the result (they are not income and not a share basis).
- It does not look at current cash. The base is the overview's `potentiallyAvailableMinor`, which is a recorded, not a cash, figure.
- Colaboradores never receive the partner component.

## Request

Bearer authentication plus the selected member and device headers, as in the rest of finance. The caller must be an active socio of the context (`SocioGuard`); colaboradores, inactive members, foreign members and unauthorized devices get `403`. The tenant always comes from the account; clients never send member or context ids. Unknown properties (for example `memberIds`) are rejected with `400`.

| Field                  | Type    | Rule                                                                                                         |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `from`, `to`           | string  | Strict real `YYYY-MM-DD` dates, `from < to`. Interval `[from,to)` in the fixed UTC-06 business timezone.     |
| `requestedAmountMinor` | integer | `1..2147483647` minor units (MXN cents). Floats, strings and `0` are rejected.                               |
| `partnerShareBps`      | integer | `0..10000` basis points of the requested amount for the equal partner component.                             |
| `workShareBps`         | integer | `0..10000`; `partnerShareBps + workShareBps` MUST equal `10000`, otherwise `400`.                            |
| `workBasis`            | enum    | `WORK_SHIFTS` (count of active shifts) or `KNOWN_MINUTES` (sum of known minutes). The bases are never mixed. |

The period uses exactly the overview's logic: sales/expenses by `occurredAt` between the two local-midnight instants, work shifts by date-only `workDate` with `workDate >= from` and `workDate < to`.

## Formula

All arithmetic is BigInt; there are no floats.

1. `partnerPool = floor(requested * partnerShareBps / 10000)`; `workPool = requested - partnerPool`. An odd minor unit therefore falls to the work pool.
2. Cap: `requested <= potentiallyAvailableMinor` of the overview for the same period. Reserves are already deducted inside that figure and are never subtracted again; inventory purchases are not re-subtracted (overview semantics); contributions do not matter.
3. Partner component: equal split among eligible partners (below).
4. Work component: split by weight among members with registered work (below).

## Eligibility

- Partner component: members with `role = socio` AND `active = true` at the moment of the call. There is no membership history in the system, so a socio who was active only part of the period is judged by today's state. The warning `PARTNER_ELIGIBILITY_IS_CURRENT_STATE` is returned whenever the partner pool is above zero. Because the caller must be an active socio, there is always at least one eligible partner when the request succeeds, so `FINANCE_DISTRIBUTION_NO_PARTNERS` is a defensive guard.
- Work component: ANY member (socio or colaborador, active or inactive) with at least one active work shift whose `workDate` is in the period. A shift is active when it has no reversal; a replacement shift created by a correction counts on its own and the reversed original does not.
- Weight: `WORK_SHIFTS` counts active shifts (a shift without duration counts as 1). `KNOWN_MINUTES` sums known minutes (a shift without minutes adds 0; duration is never invented).

## Rounding

- Equal split: `base = floor(pool / n)`; the remainder `r` adds one minor unit to the first `r` members ordered by `memberId` ascending (string comparison). Example: 10000 over 3 partners gives 3334, 3333, 3333.
- Work split: largest remainder (Hamilton). Each member gets `floor(pool * u_i / U)`; leftover units go to the members with the largest `(pool * u_i) mod U`, ties by `memberId` ascending. Members with zero weight get 0 and never a leftover unit. The service asserts that the total equals the pool exactly.
- Total: `distributedMinor` always equals `requestedAmountMinor`; `undistributedMinor` is `0` on success.

### Worked example

600000 requested, 50/50, `WORK_SHIFTS`. Alberto has 2 shifts and Adid 3; both are active socios.

| Member  | Partner | Work   | Total  |
| ------- | ------- | ------ | ------ |
| Alberto | 150000  | 120000 | 270000 |
| Adid    | 150000  | 180000 | 330000 |

The partner pool is 300000 (150000 each). The work pool is 300000 split 2:3.

## Response

All amounts are integer minor units.

| Field           | Meaning                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `period`        | `from`, `to`, `fromInstant`, `toInstant`, `utcOffsetMinutes: -360`, `interval: "[from,to)"`                                                                                        |
| `simulation`    | always `true`                                                                                                                                                                      |
| `persisted`     | always `false`                                                                                                                                                                     |
| `currency`      | `MXN`                                                                                                                                                                              |
| `financialBase` | `potentiallyAvailableMinor`, `requestedAmountMinor`, `remainingAvailableMinor` (available minus requested), `status` (`complete` or `partial`, mirrors the overview cost coverage) |
| `rule`          | echo of `partnerShareBps`, `workShareBps`, `workBasis` plus `partnerMode: "EQUAL"`                                                                                                 |
| `pools`         | `partnerPoolMinor`, `workPoolMinor`                                                                                                                                                |
| `members`       | Sorted by `memberId` ascending. Contains every eligible partner (even with no work) and every member with at least one active shift in the period                                  |
| `totals`        | `distributedMinor`, `undistributedMinor`                                                                                                                                           |
| `warnings`      | Array of `{code, message}`; codes are stable, messages are informational English                                                                                                   |
| `simulationFingerprint` | `sim1:` followed by the sha256 hex of the canonical JSON of `period`, `currency`, `financialBase`, `rule`, `pools`, `members`, `totals` and `warnings` (it excludes itself, `simulation`, `persisted` and any timestamp). Identical data always yields the same value; any change of the data the participants saw changes it. Phase 5.5 agreements require it to detect drift |

Each `members` item: `memberId`, `name`, `role` (`socio`/`colaborador`), `isActive`, `partnerEligible`, `partnerAmountMinor`, `workUnits` (weight in the chosen basis), `shiftCount`, `knownMinutes`, `unknownDurationCount`, `workAmountMinor`, `totalMinor`.

## Warning codes

| Code                                   | When                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `SIMULATION_ONLY`                      | Always                                                                                |
| `NOT_A_PAYMENT_OR_OBLIGATION`          | Always                                                                                |
| `OPERATING_RESULT_PARTIAL`             | The overview cost coverage is partial; the available amount may be overstated         |
| `MISSING_SALE_COST`                    | Forwarded from the overview when some sold lines have no recorded cost                |
| `PARTNER_ELIGIBILITY_IS_CURRENT_STATE` | The partner pool is above zero; eligibility is the current state, there is no history |
| `WORK_SHIFTS_WITHOUT_DURATION`         | `KNOWN_MINUTES` and some active shift lacks minutes (the message includes the count)  |
| `INACTIVE_MEMBER_RECEIVES_WORK_AMOUNT` | An inactive member has work in the period and receives a work amount above zero       |

Partial costs never block the simulation.

## Error codes

| HTTP | Code                                                 | Meaning                                                                                                          |
| ---- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 400  | (validation)                                         | Invalid body, unknown property, bps not adding to 10000, bad or unordered dates                                  |
| 401  | -                                                    | Missing or invalid bearer token                                                                                  |
| 403  | -                                                    | Caller is not an active socio of the context, or invalid member/device headers                                   |
| 422  | `FINANCE_DISTRIBUTION_EXCEEDS_AVAILABLE`             | Requested amount is above `potentiallyAvailableMinor`, or that amount is zero or negative                        |
| 422  | `FINANCE_DISTRIBUTION_NO_WORK`                       | `workShareBps > 0` and no work units. The message says either "No active work shifts" or "lack a known duration" |
| 422  | `FINANCE_DISTRIBUTION_NO_PARTNERS`                   | `partnerShareBps > 0` and no eligible partners (defensive; see eligibility)                                      |
| 422  | `FINANCE_OVERVIEW_OVERFLOW` and other overview codes | Overview protections propagate unchanged                                                                         |

There is no silent redistribution: a component with zero bps does not need its base, but a positive component without a base fails.

The 422 body shape is the overview's: `{ code, message }` (plus Nest's status fields). Success is `200`, not `201`, because nothing is created.

## Consistency and tenancy

One callback-form `RepeatableRead` transaction reads everything through the tenant-scoped client, so RLS applies and the financial base, shifts and members come from the same snapshot. The overview arithmetic is shared through `FinanceOverviewService.compute(tx, contextId, from, to)`; the public overview endpoint behaves exactly as before.

## Frontend contract summary

Request:

```json
{
  "from": "2026-10-01",
  "to": "2026-11-01",
  "requestedAmountMinor": 600000,
  "partnerShareBps": 5000,
  "workShareBps": 5000,
  "workBasis": "WORK_SHIFTS"
}
```

```ts
type DistributionWorkBasis = 'WORK_SHIFTS' | 'KNOWN_MINUTES';
interface DistributionSimulationRequest {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD, after from
  requestedAmountMinor: number; // integer 1..2147483647
  partnerShareBps: number; // 0..10000
  workShareBps: number; // 0..10000, sum with partnerShareBps = 10000
  workBasis: DistributionWorkBasis;
}
interface DistributionMember {
  memberId: string;
  name: string;
  role: 'socio' | 'colaborador';
  isActive: boolean;
  partnerEligible: boolean;
  partnerAmountMinor: number;
  workUnits: number;
  shiftCount: number;
  knownMinutes: number;
  unknownDurationCount: number;
  workAmountMinor: number;
  totalMinor: number;
}
interface DistributionSimulationResponse {
  period: {
    from: string;
    to: string;
    fromInstant: string;
    toInstant: string;
    utcOffsetMinutes: -360;
    interval: '[from,to)';
  };
  simulation: true;
  persisted: false;
  currency: 'MXN';
  financialBase: {
    potentiallyAvailableMinor: number;
    requestedAmountMinor: number;
    remainingAvailableMinor: number;
    status: 'complete' | 'partial';
  };
  rule: {
    partnerShareBps: number;
    workShareBps: number;
    workBasis: DistributionWorkBasis;
    partnerMode: 'EQUAL';
  };
  pools: { partnerPoolMinor: number; workPoolMinor: number };
  members: DistributionMember[];
  totals: { distributedMinor: number; undistributedMinor: number };
  warnings: { code: string; message: string }[];
  simulationFingerprint: string; // 'sim1:' + 64 hex chars
}
```

Display guidance: show the `SIMULATION_ONLY` and `NOT_A_PAYMENT_OR_OBLIGATION` warnings prominently, never label amounts as "owed" or "paid", surface `financialBase.status = partial` as a caution, and branch on the 422 `code` rather than on the message.

## Limitations

- Partner eligibility reflects the current active socios; membership history does not exist.
- Only equal partner shares exist (`partnerMode: "EQUAL"`); there is no capital-based or custom weighting.
- Work value is not monetized: it is a weight (shifts or minutes), not an hourly rate.
- Reversals are evaluated as of the server snapshot, like the overview.
