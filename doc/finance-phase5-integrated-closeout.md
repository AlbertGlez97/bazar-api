# Phase 5 integrated closeout

Phase 5 is locally verified and closed with the accepted fixture limitations below. The simulator remains pure, online-only and ephemeral: it neither pays members nor persists simulations. Source/test checks ran October 7; the parent completed the normal logout/relogin browser check October 9. No Phase 6 work, push, merge, rebase, squash, public deployment or Cloudflare operation occurred.

## Git and review boundaries

Both repositories remain on `feat/finance-distribution-simulator`.

| Repository | Initial source boundary | Verified source boundary | Parent native assessment |
| --- | --- | --- | --- |
| API | `38996a8` | `2d5c9ad` | Medium, 69 authored lines, `under_budget`, `review_due=false` |
| Frontend | `ee0ce80` | `b04fba4` | Medium, 140 authored lines, `under_budget`, `review_due=false` |

Assessments apply to those committed ranges. No candidate review was granted or run; no independent review approval is claimed. The parent observed a fresh 132-test focused frontend spot check and diff-check. This report/tracker commit is passive documentation after the source boundary.

## Stack and data preservation

The local API/frontend were rebuilt and served successfully. The stack worker observed 25 applied migrations, none pending, no new Phase 5 migration, retained FORCE RLS/restricted application role, and preserved PostgreSQL start time, volumes and data. The compiled frontend API path remained `/api/v1`; the parent activated the updated PWA. Backend automated tests targeted the separate local `bazar_test` database on port 5433, never the financial laboratory database.

The parent created the second partner through the normal member UI after explicit user authorization of the credentials-email destination/service; the UI confirmed delivery. That authorized external email is the exception to the otherwise local work. No email address, credential, JWT or private filesystem path is recorded here.

## Controlled financial and work data

All money below is integer minor units (100 = MXN1). Separate completed cash sales with known zero cost established the September 27 and September 28 bases of 750000. September 28 had no active reserve at final readback.

| Participant | September 28 work | Known minutes | Attribution |
| --- | --- | --- | --- |
| Testing Cruz | 2 shifts: 60 + 60 minutes | 120 | Existing first participant, accepted as the Alberto-equivalent; not renamed |
| Adid Prueba Fase5 | 3 shifts: 90 + 90 + unknown | 180 | New active partner through the authorized normal UI flow |

A user-authorized additional September 29 Testing shift had unknown duration. Applying September 28 through the exclusive September 30 end yielded 3 shifts each and still 120/180 known minutes. The principal September 28-only scenario stayed unchanged. The pre-existing October 7 Phase 4 reserve of 300000 remained intact, with potential availability 450000.

## Real API and Chrome distribution results

Principal request: 600000 against 750000 potentially available. The remainder is 150000, distributed total 600000 and undistributed residual zero. The parent verified real API responses and Chrome rendering; the frontend did not recompute money.

| Rule | Partner/work pools | Testing total | Adid total |
| --- | --- | --- | --- |
| 50/50, by shifts | 300000 / 300000 | 270000 | 330000 |
| 70/30, by shifts | 420000 / 180000 | 282000 | 318000 |
| 100/0 | 600000 / 0 | 300000 | 300000 |
| 0/100, by shifts | 0 / 600000 | 240000 | 360000 |
| 50/50, by known minutes | 300000 / 300000 | 270000 | 330000 |

### Shifts and hours

The principal shifts base was 2 versus 3. The hours base was 120 versus 180 minutes, displayed as 2h and 3h; the unknown-duration shift did not add time. In the extended September 28-30 range, equal 3/3 shifts produced 300000 each, while the unchanged 120/180 minutes produced 270000/330000. Real API and UI checks passed, with two unknown-duration warnings in the extended range.

### Collaborators, zero-work partners and rounding

- September 27 contained no shifts: real 100/0 API/UI returned 300000 per partner and zero work amounts. A real 50/50 retry returned `FINANCE_DISTRIBUTION_NO_WORK`, a human explanation and the previous-configuration label.
- No extra collaborator was created because that would require another authorized credentials email. Accepted real HTTP fixtures prove a collaborator has no partner eligibility/amount but can receive work money (`test/finance-distribution.e2e-spec.ts`, scenarios around lines 574-603 and 699-724); the frontend badge fixture confirms rendering.
- No inactive member was created just to force an edge case. Accepted HTTP fixtures cover inactive workers. The defensive no-partners path is unit-covered: an authorized caller is itself an active partner, so the real authenticated no-partners setup was not fabricated.
- Real HTTP fixture coverage for three partners divides 10000 as 3334/3333/3333, ordered by member ID (same e2e file, scenario around lines 557-573). The two-partner live case has no rounding residual.

## HTTP 422, warnings and partial costs

A real 750001 request exceeded the 750000 base and returned structured 422. To verify changing server data against a cached UI base, the parent normally created a temporary exact-period reserve of 200000, reducing server availability to 550000 while the UI still showed 750000. Retrying the unchanged 600000 request produced the human `EXCEEDS_AVAILABLE` explanation.

That browser check exposed an unlabeled previous result. After the fix and new PWA bundle activation, the repeated real 422 showed both the error and previous-configuration label. Both temporary reserves were normally reversed; final September 28 availability returned to 750000 with reserves zero. A successful retry cleared the error and stale label.

Current-partner eligibility is explained as current state, not historical ownership; unknown minutes are human-readable. Legacy missing-cost sales cannot be created through today's clean normal product flow. Accepted isolated API fixtures verify partial-cost status/warnings (e2e scenarios around lines 808-823), and the frontend fixture verifies the partial warning precedes figures. No laboratory SQL edits were used to manufacture that state.

The added real HTTP overflow test stores test-only SaleItem quantity and unit cost 2147483647. Each database Int fits, but the BigInt cost product exceeds safe money; the distribution endpoint propagates 422 `FINANCE_OVERVIEW_OVERFLOW`. Structured 422 codes remain authoritative. HTTP400 has no structured backend code: text regex hints are supplementary and the generic fallback remains unchanged.

The WorkShift composite member/context FK, tenant RLS, inclusive grouped-worker member query and RepeatableRead snapshot preserve member attribution. The defensive missing-member assertion was retained; no speculative backend fix was introduced.

## Persistence and session lifetime

Source/tests establish no simulator localStorage, IndexedDB, durable queue, history or new-table writes. API overview values remained stable across simulations except `generatedAt`. No runtime storage tracing was performed, and none is claimed.

- Returning through routes may retain the last in-memory result by design; existing mounted-view tests cover restoration.
- Real page reload cleared amount/result and restored the default period.
- Real logout removed financial content. Normal relogin on October 9 auto-loaded the month's base with an empty amount and no result.
- The bound-member UI did not provide a valid same-allowed identity switch while the view stayed mounted. Deterministic mounted tests instead verify token/account/API/member/device changes, clearing prior visit state, reloading base exactly once and ignoring stale in-flight responses. This specific browser identity transition was not separately reproduced.
- No offline Phase 5 network test was performed or offline simulator capability added.

## Responsive layout and accessibility

Parent Chrome checks used real viewports 320/390/768/1280, not an iframe. Document widths were 305/375/753/1265, all inside the viewport. Presets, form, cards and warnings stayed legible; the desktop menu collapsed for mobile. Screenshots were taken after stabilization: an immediate post-resize frame could still show the old layout, not an application defect.

The actual amount input described the rendered maximum using `sim-amount-hint`. Deterministic tests also cover composition with parse-error help and absence of dangling IDs. Real keyboard checks observed:

1. Tab from amount to the 50/50 preset and Shift+Tab back; ArrowLeft from hours to shifts.
2. Tab to Calculate with a visible 2.4px solid outline; Enter calculated and focused the result heading.
3. Enter on Change rule focused the partner field; New simulation cleared the result and focused amount.

## Configuration staleness and Phase 1-4 regression

Amount, percentages and work-basis edits label an older result. Draft date changes display the explicit Update warning and disable calculation until applied; the applied new period returns the correct result. A failed unchanged calculation also labels the previous result; a successful retry clears that label. An unrelated overview failure does not falsely label a successful result.

The parent loaded real Overview, Contributions, Expenses, Work shifts and Reserves screens. October 7 prior-phase figures/reserve stayed unchanged. No payment, obligation or financial posting was created by simulation.

## Bugs, fixes and commits

| Confirmed defect | Fix and observed deterministic proof | Frontend commits |
| --- | --- | --- |
| Allowed-to-allowed attribution reset left the mounted base blank/old inputs | Watch token/account/API/member/device alongside access; clear visit-local state and refresh valid base. Initial RED: 5 regressions; token-only RED: 1; final focused GREEN includes all sources. | `6d3ea3d` + `c6e3c69`, then `2dbc2e4` |
| Maximum hint did not describe the actual input | Optional external description composed with parse-error ID; no dangling hint. RED: 2 failures, then GREEN. | `014c36a` |
| Rejected unchanged retry displayed an apparently current prior result | Include simulation error in stale-result state without client arithmetic. RED: 1 failed/65 passed; focused GREEN: 132. Real browser 422 repeated successfully after rebuilding. | `b04fba4` |

The first attribution commit inadvertently contained tests only because a newline-sensitive source patch did not apply before commit; `c6e3c69` completes the same unit. The paired history is preserved and disclosed, not amended, rebased or squashed. API `2d5c9ad` adds the real HTTP overflow test and initial evidence tracker; production backend logic is unchanged.

## Attributed checks and accepted limits

The bounded source/verification workers observed these October 7 results; they are not represented as parent full-suite execution:

| Repository | Commands | Final observed outcome |
| --- | --- | --- |
| Frontend | Focused view/CashInput/distribution-store vitest run | 132 passed |
| Frontend | `npm.cmd run test:run` | 3883 passed in 214 files |
| Frontend | `npm.cmd run lint`; `npx.cmd vue-tsc --noEmit`; `npm.cmd run build`; diff-check | Passed; existing build size/import warnings retained |
| API | `npm.cmd test` | 577 passed in 36 files |
| API | Focused distribution HTTP e2e | 46 passed |
| API | `npm.cmd run test:e2e` | Final serial run: 839 passed in 33 files |
| API | Lint; build-tsconfig typecheck; build; diff-check | Passed; two existing sales-conflict lint warnings retained |

The first overlapping frontend-full/API-e2e run had six existing-spec 5000ms timeouts: business-registration's email-failure retry and change-password's shared/bound roles, existing-token validity, collaborator 403, password boundaries and concurrent changes. It had 833 passed/6 failed. One serial rerun using the unchanged normal runner/timeouts passed all 839. Resource contention is supported by that outcome, not claimed as a proven root cause. No failures were hidden or timeout/configuration changes made.

Accepted evidence limits are explicit above: partial costs, collaborators, inactive members, no-partners and three-partner rounding use accepted deterministic/HTTP fixtures rather than fabricated live financial data. Same-allowed mounted identity uses deterministic tests, not a separate browser replay. No storage tracing or offline test is claimed. Engram mirror remains pending because runtime identity is unavailable and memory mutation tools are not permitted; the local tracker/report are the recovery record.

## Final result and next action

IC1-IC5 are complete for this authorized Phase 5 closeout, including real integration, proportional fixes, source verification and parent native assessment. This is not native review approval, remote publication, Phase 6 authorization or authorization to pay members. The next action is the user's decision about any later delivery/work; existing data and feature branches remain preserved.

Passive report verification: structural readback, scope/attribution/fixture-limit checks, privacy-pattern scan and diff-check. No tests or rebuild were necessary for this final documentation-only unit. Rollback boundary: this report plus closeout tracker evidence only, not the verified source/test commits.
