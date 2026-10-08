# Phase 4 integrated closeout

**Status: closed for the authorized local scope, with accepted evidence limitations.** Existing Phase 4 branches were integrated in the preserved local laboratory; frontend bugs were fixed, required automated checks passed, real browser/API checks completed, and native review was approved and acknowledged. No distribution, payments or Phase 5 behavior was introduced.

## Scope and evidence ownership

The parent operated real Chrome, directed user-owned offline/API recovery actions, and owned native review. Workers ran automated suites, laboratory rebuild/migration checks and controlled real API replay/boundary checks. Mock/legacy fixture evidence is identified separately below. This report does not turn simulated evidence into manual proof.

No push, PR, merge, rebase, squash, public deployment or Cloudflare operation occurred. Existing records and Docker volumes were preserved. No financial SQL patch, database reset or new collaborator account was used. Phase 4 remains online-only; IndexedDB v4 and earlier financial queues are unchanged.

## Git and commits

Both repositories remain on feat/finance-overview-reserves, not main.

| Repository | Initial source boundary | Final source boundary |
| --- | --- | --- |
| API | dcba462e6052170048a84ef0213e768e833e3b72 | Same source: backend logic unchanged during closeout. |
| Frontend | d0b0644; branch ancestor6e05a0a from workshifts, merge-base main c707210 | 2f5971c38678d26c27158fe9f135968607f299e4 |

Frontend fixes, all dated 2026-10-07 (-06:00):
- d4623e697335da221338c6d406979687ad9515ae: fix(finance): isolate session caches and asynchronous updates.
- ee753237807d3fa35f76f9d75445acd82881d2a8: fix(finance): keep displayed cost coverage complementary.
- 2f5971c38678d26c27158fe9f135968607f299e4: fix(finance): preserve exact reserve periods and confirmation state.

Initial EOL-only status entries were not reset or broadly normalized. Six residual frontend M entries have no substantive diff. Frontend passive tracker commit:6e71c777a74e19c382427549dcb755ea55f4b19c (docs(finance): record acknowledged phase 4 validation).

Final documentation commits are passive; their identities are supplied by the parent readback after creation, rather than self-referential amendment.

## Docker, migration and data preservation

Laboratory worker rebuilt the current API/frontend branches using the existing nginx override/proxy. Compiled frontend requests use /api/v1; the MSYS-corrupted prefix is absent. The parent explicitly activated the PWA update and checked the current bundle, including the remount fix.

The existing local frontend/API endpoints are localhost:8080 / localhost:3100. PostgreSQL start state and volumes deploy_postgres_prod_data/deploy_api_uploads were preserved. Real additive migrate deploy completed against the existing laboratory:25 migrations, including FinanceReserve. Both reserve tables have FORCE RLS; the runtime role is NOSUPERUSER/NOBYPASSRLS. No db push/reset or volume deletion occurred. Automated backend tests used a separate localhost:5433 bazar_test database, not the laboratory data.

## Controlled data and manual arithmetic

Parent real Chrome checks used October 7,2026. Normal UI created two products/two sales, operating expenses, an inventory purchase, a SOCIO contribution and four work shifts; prior records were not modified to force agreement.

| October 7 figure | MXN | Minor units |
| --- | ---: | ---: |
| Sales:10000 +5000 | 15000 | 1500000 |
| Known sold cost:4000 +2000 | 6000 | 600000 |
| Recorded gross margin | 9000 | 900000 |
| Operating expense:500 transport +1000 bazaar | 1500 | 150000 |
| Operating result | 7500 | 750000 |
| Inventory purchases, separate from operating expenses | 3000 | 300000 |
| Capital contributions, separate from sales | 8000 | 800000 |

Work:three known shifts of360 +360 +240 minutes, plus one unknown-duration shift; four shifts,960 known minutes, one unknown. The overview matched 1500000 -600000 -150000 =750000 minor units. Recorded operating result is not cash, withdrawable profit or a distribution.

## Reserves, reversal and exact periods

Parent created a MXN3000 purchase reserve, then a MXN1000 bazaar reserve. Active planned total3000 then4000 changed only potential availability:4500 then3500. Reversing the bazaar reserve restored4500; the historic item and cancellation reason remained visible. The principal MXN3000 reserve remains active.

Reservas default/Este mes now selects inclusive October1..31, serialized as [2026-10-01,2026-11-01). A MXN1 auxiliary full-month reserve matched the real server list/full-month overview:operating result5627, potential5626 while active. That auxiliary reserve was later cancelled. Earlier-period data remain preserved. Backend exact-period matching is unchanged; general Resumen remains month-to-date/analysis, and linked/custom ranges remain exact. A monthly reserve affects only the identical full-month overview.

Leap-February and December-to-January serialization and UTC06 business-date boundaries are automated regression tests, not claims of separate real browser runs for every calendar case.

## Real idempotency and temporal boundaries

Authorized real API worker observed:

| Operation | Result |
| --- | --- |
| Reserve creation | 201 |
| Exact same-ID/body replay | 200 |
| Changed payload using the same ID | 409 |
| Reversal | 201 |
| Exact reversal replay | 200 |
| A second distinct reversal of the same reserve | 409 |

Uniqueness was one reserve record; after cancellation, active0/historic1. These were real laboratory API responses, not mocked service results.

Controlled contributions at the business UTC06 boundary:

| Recorded instant | Minor units |
| --- | ---: |
| 2026-09-29T06:00:00.000Z | 11 |
| 2026-09-30T05:59:59.999Z | 22 |
| 2026-09-30T06:00:00.000Z | 44 |
| 2026-10-01T05:59:59.999Z | 88 |
| 2026-10-01T06:00:00.000Z | 176 |

Observed relevant half-open window deltas were33/132/165/176 minor units. October7 baseline stayed unchanged. After normal relogin, the current-month contribution figure was MXN8101.76; the October7 day contribution remained MXN8000.

## Partial costs and accepted fixture limitation

There is no clean current-domain API mechanism to create the required legacy missing-cost record. The accepted proof uses automated legacy fixtures for partial cost warnings, partial potential availability and coherent coverage:99.x never displays100, and known plus missing never totals101. Non-string JSON receipt dates already failed downstream validation; explicit string guards and null/number/object/array contract cases are hardening, not a reproduced runtime crash.

No SQL financial patch was used. Missing-cost behavior is therefore fixture-backed, not a live missing-cost browser claim.

## Offline, API recovery and session isolation

Parent/user used real Chrome DevTools Network Offline. A create attempt displayed: "No pudimos guardar la reserva. Revisa tu conexión; si reintentas no se duplicará." No pending/success state was invented. Restoring connectivity and retrying the same form created one MXN1 auxiliary reserve, then normal cancellation removed it from active totals.

For real API unreachability, only the API was stopped. The attempt failed with a generic error. Automatic restart policy refused the attempted automatic recovery; the user restored deploy-api-1. The parent verified the container running and HTTP200. Retrying the same form created one MXN1 auxiliary reserve, subsequently cancelled. Both auxiliary retry-test reserves are cancelled; the principal3000 remains.

Loaded summary -> logout -> login displayed no retained financial data. A new normal authorized SOCIO session/member context showed loading before a fresh summary fetch. Singleton Phase 4 caches reset on session/context replacement, and generation guards suppress late read/write continuations. Already-sent requests cannot be undone by logout. No new offline persistence was added.

## Responsive layout, accessibility and regressions

Parent measured real Chrome viewports320/390/768/1280, not an iframe. Both finance views had no horizontal overflow; document widths305/375/753/1265 stayed within their viewports. Amounts/cards/forms were legible; the existing desktop menu was collapsed before mobile content checks. The320px cancellation field stayed within bounds104.8..275.39.

Tab/ShiftTab navigation, field labels, cancellation reason focus and return to Anular after Conservar were verified. No screen-reader run is claimed. Existing Phase1-3 navigation loaded. Only a SOCIO session was available; no collaborator was created. Automated SocioGuard/RLS checks provide collaborator/restricted-role evidence, not a live collaborator UI run.

## Bugs found and fixed

| Finding | Outcome |
| --- | --- |
| Off-view logout/account cache leak | Auth resets only volatile Phase 4 caches; late async results cannot repopulate another session. |
| Independent coverage rounding | Known/missing display percentages are complements. |
| Slow optional partner summary | Overview publishes independently; stale partner names are guarded. |
| Filters implicitly applying draft dates | Scope/status retain the applied range, including invalid drafts. |
| Saved message using mutable post-await period | Canonical submitted range captured before awaiting receipt/refresh. |
| Monthly planning versus month-to-date | Only reserve monthly preset uses the full civil month; exact backend matching unchanged. |
| Real navigation/remount empty confirmation period | Visit-local action feedback cleared on remount; immediate/captured-period confirmation preserved. |
| Receipt date types | Explicit guards/tests; hardening only, no reproduced runtime defect. |

Deterministic RED was observed before fixes:initial18 failing assertions, and a separate remount regression1 failure. Final GREEN is recorded below. Parent rebuilt and validated the real remount/navigation correction.

## Automated verification

| Actor and scope | Observed result |
| --- | --- |
| Backend worker focused | 51 unit /335 HTTP passed. |
| Backend worker full | 498 unit /787 HTTP passed. |
| Backend worker lint/build/typecheck/diff | Passed; two existing lint warnings and PostgreSQL deprecation notice were non-failing. |
| Frontend writer focused | 154 tests in6 files passed. |
| Frontend writer full | 3734 tests in210 files passed. |
| Frontend writer lint/vue-tsc/build/diff | All passed. Nonblocking dependency chunk-size/router-stub warnings documented. |
| Parent independent focused spot check | 154 tests passed. |

No functional rerun was necessary for the final passive documentation-only changes; structural readback, scoped diff checks and a secret-pattern scan were performed before documentation commits.

## Native review and final state

Parent reports all four native review lenses completed with no findings. Approved review was acknowledged using the exact continuation; returned action acknowledged and authority burned.

- Lineage: review-f0c95b7d441994fe.
- Target: sha256:324c8f8ed4426e814bc6312f342ec0eb1e9ad076928a53499dde2d8ef1145996.
- Frontend source boundary:2f5971c38678d26c27158fe9f135968607f299e4.

IC1-IC4 are complete on observed evidence with the accepted partial-cost/collaborator/screen-reader limitations above. Data/volumes remain preserved, auxiliary reserves cancelled, principal purchase reserve active, and existing phases operational. No distribution/payment calculation or remote delivery occurred. Local Phase 4 closeout is complete; any push/PR/merge remains a separate user decision.

Engram writes were not attempted because authoritative runtime session registration is unavailable. Mirrors remain pending; no session identity was invented.
