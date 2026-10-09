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

- [x] DA1: Canonical JSON helper, simulator refactor (`simulateInTx`) and `simulationFingerprint`.
- [x] DA2: Prisma models, migration, RLS and immutability triggers.
- [x] DA3: DTOs.
- [x] DA4: Agreements service (create, replay, drift, folio, replaces).
- [x] DA5: Reversal, list and detail.
- [x] DA6: Controller, module and impersonation matrix.
- [x] DA7: End-to-end tests.
- [x] DA8: Contract documentation and full verification.

## Route, evidence and commit per task

| Task    | Route                 | Trigger evidence                                               | Checks observed                                                                                                                                                  | Commit           |
| ------- | --------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| DA1     | Single bounded writer | Refactor of a financial service plus new helper                | 11 files/171 unit tests green (canonical-json 14, simulator 23 incl. 5 fingerprint cases); Phase 5 e2e 46 green                                                  | 7ca6645, 38866cf |
| DA2     | Single bounded writer | New schema, migration, triggers                                | `prisma validate`, `db:migrate:test` applied, `migrate diff` against schema: no difference; all 26 migrations replay from scratch on an empty database; build OK | e7380df          |
| DA3     | Single bounded writer | Strict DTOs                                                    | 59 DTO unit tests green (incl. strict-pipe rejection of server-owned properties)                                                                                 | 09f059f          |
| DA4+DA5 | Single bounded writer | Transactional service with retry/queue; reversal, list, detail | 36 service + 16 snapshot unit tests green (replay-before-drift, drift persists nothing, year rollover, retry, queueing)                                          | 9f275c8          |
| DA6     | Inline (wiring)       | Controller, module, matrix routes                              | build OK; impersonation matrix green                                                                                                                             | a3515b4          |
| DA7     | Single bounded writer | HTTP end to end                                                | 43 e2e green, repeated 3x full and 6x concurrency-only without flakiness                                                                                         | b7d23ee          |
| DA8     | Single bounded writer | Docs and full regression                                       | unit 693/40 files (baseline 577/36), e2e 906/34 files (baseline 839/33), lint 0 errors (2 pre-existing warnings), nest build OK, git diff --check clean          | docs commit      |

## Progress and boundaries

- Rollback: revert only this branch's work-unit commits.
- Engram mirror pending (the single bounded writer has no memory tooling in this run).
- Deviations: in-process per-context creation queue added on top of the bounded retry (10 simultaneous creates otherwise produced 503 BUSY with 5 attempts); backend messages stay in English (repo convention), only the document `notice` is Spanish; `voidedAt` in the list is the reversal `occurredAt`.

## Review follow-ups

- Native review found three weak tests, fixed in the commit `test(finance): prove check constraints, retry re-simulation and tenant isolation for agreements` (hash in git log): (1) the DB-check e2e now uses a distinct folio per insert and asserts the exact Postgres CHECK name for pools, distributed, bps and participant sums; (2) the retry unit test now fails the first attempt after the simulation and proves the retry re-simulates (2 calls, fresh data persisted, drift decided on the fresh fingerprint); (3) the tenant-isolation e2e compares counts of both contexts before and after the foreign reversal attempt.
- The impersonation matrix probes POST routes with `{}` (400 before any insert), so it creates no agreement rows; verified 0 leftover rows after the suite.

## Next step

Feature complete locally; no push, merge or deploy.
