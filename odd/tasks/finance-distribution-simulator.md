# Finance distribution simulator

## Objective

Expose a pure, non-persisted simulator, `POST /api/v1/finance/distribution-simulations`, that splits a requested amount of the period's potentially available money between an equal partner component and a work-contribution component. Socio-only. No migration, no new Prisma model, no writes of any kind.

## Constraints and design

- Branch: feat/finance-distribution-simulator, created from feat/finance-overview-reserves HEAD 3f813167903ef2cfe35a58ae4993d3ce3955ed2e (dcba462 Phase 4 close plus one docs commit). Depends on unmerged Phase 4 backend.
- bazar-api only. No frontend, deploy, production containers, `.env*`, push, merge or Cloudflare.
- Period semantics identical to the overview: `[from,to)` in fixed UTC-06 business time; shifts by `workDate`.
- BigInt arithmetic only. partnerPool = floor(requested * partnerShareBps / 10000); workPool = requested - partnerPool.
- Partner component: equal split among members with role socio AND active=true (current state, no membership history). Remainder cents go to the first r members by memberId ascending.
- Work component: any member with at least one active (non-reversed) shift in the period. Weights: WORK_SHIFTS counts shifts; KNOWN_MINUTES sums known minutes. Largest remainder, ties by memberId ascending.
- Cap: requested <= potentiallyAvailableMinor of the overview computation (reserves already deducted). 422 FINANCE_DISTRIBUTION_EXCEEDS_AVAILABLE, FINANCE_DISTRIBUTION_NO_WORK, FINANCE_DISTRIBUTION_NO_PARTNERS.
- One RepeatableRead tenant transaction through `tx`; overview arithmetic shared through `FinanceOverviewService.compute(tx, ...)`.
- Planning heuristic: about 400 authored changed lines per task, advisory only.

## Tasks and acceptance

- [x] DS1: Extract overview computation into `compute(tx, contextId, from, to)` with zero behavior change.
- [ ] DS2: Pure allocation engine (`splitPools`, `allocateEqual`, `allocateByWeight`) with exhaustive and property-style unit tests.
- [ ] DS3: Request DTO (strict, bps sum, amount bounds, workBasis) and stable error codes.
- [ ] DS4: Distribution service with unit tests.
- [ ] DS5: Controller, module registration and impersonation matrix entry.
- [ ] DS6: End-to-end tests.
- [ ] DS7: Contract documentation and full verification.

## Route, evidence and commit per task

| Task | Route | Trigger evidence | Checks observed | Commit |
| --- | --- | --- | --- | --- |
| DS1 | Delegated direct (single writer) | Refactor of a 200-line financial service | 12 overview unit tests green unchanged; tsc build config OK | pending |

## Progress and boundaries

- Rollback: revert only this branch's work-unit commits.
- Engram mirror pending.

## Next step

DS2 allocation engine.
