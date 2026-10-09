# Finance distribution agreements

## Objective

Phase 5.5: persist an immutable, auditable "Acuerdo de reparto" created from a distribution simulation. It is NOT a payment, withdrawal, debt or obligation, is not a legal contract, and has no PDF, signature or offline support. The simulator endpoint stays pure. Socio-only.

## Constraints and design

- Branch: feat/finance-distribution-agreements, created from feat/finance-distribution-simulator HEAD 0eb798f (two commits above 38996a8 that were not part of the Phase 5 session: 2d5c9ad HTTP overview overflow test, 0eb798f Phase 5 closeout docs; both respected, nothing in them modified).
- bazar-api only. No frontend, deploy, production containers, `.env*`, push, merge or Cloudflare.
- Simulation fingerprint `sim1:<sha256 of canonical JSON>` lets the server detect that the data changed between simulating and creating (409 FINANCE_AGREEMENT_SIMULATION_CHANGED, nothing persisted).
- Create: one RepeatableRead transaction, authorize (FOR SHARE), advisory identity lock, replay BEFORE drift and BEFORE the counter, re-simulate with `simulateInTx`, drift check, folio via atomic counter upsert, insert agreement and participants. Whole transaction retried (5 attempts) on 40001/P2034.
- Folio `AC-<YYYY>-<5+ digits>`, year of the server `receivedAt` in business time (UTC-6), gapless per context and year.
- Immutability enforced by BEFORE UPDATE OR DELETE triggers on agreement, participant and reversal tables (the provisioner re-grants UPDATE/DELETE every start, so REVOKE is unreliable). The counter table is mutable by design.
- Planning heuristic: about 400 authored changed lines per task, advisory only.
- Baseline before this work: 577 unit tests (36 files), 839 e2e tests (33 files).

## Tasks and acceptance

- [ ] DA1: Canonical JSON helper, simulator refactor (`simulateInTx`) and `simulationFingerprint`.
- [ ] DA2: Prisma models, migration, RLS and immutability triggers.
- [ ] DA3: DTOs.
- [ ] DA4: Agreements service (create, replay, drift, folio, replaces).
- [ ] DA5: Reversal, list and detail.
- [ ] DA6: Controller, module and impersonation matrix.
- [ ] DA7: End-to-end tests.
- [ ] DA8: Contract documentation and full verification.

## Route, evidence and commit per task

| Task | Route | Trigger evidence | Checks observed | Commit |
| --- | --- | --- | --- | --- |
| DA1 | pending | | | |
| DA2 | pending | | | |
| DA3 | pending | | | |
| DA4 | pending | | | |
| DA5 | pending | | | |
| DA6 | pending | | | |
| DA7 | pending | | | |
| DA8 | pending | | | |

## Progress and boundaries

- Rollback: revert only this branch's work-unit commits.
- Engram mirror pending (the single bounded writer has no memory tooling in this run).

## Next step

DA1.
