# Branded business emails

Improve the business approval, approval request and credentials backup emails without changing their security information or delivery behavior.

## Scope and checks

- Authorized: deliverability guidance and the business email HTML renderers/tests.
- Excluded: DNS mutation, unrelated member/device emails, delivery routing, push and deployment.
- TDD: active by explicit user instruction; `npm.cmd test -- src/email/email.service.spec.ts` (observed RED, GREEN, refactor).
- Required: build, lint, full unit tests; rendering and a real test email only with a confirmed recipient and available tooling.
- Forecast: approximately 300 authored additions plus deletions; delivery strategy `ask-on-risk`, no push without confirmation.
- Engram mirror: pending; runtime session attribution is unavailable.

## Tasks

- [x] EMAIL-1: document measured DNS findings, safe DMARC setup and reputation caveats. Runtime proof: DNS investigation supplied by the parent; documentation readback. Commit: `e093b1c`. Rollback: deliverability document only.
- [x] EMAIL-2: share a branded table/inline shell across the business emails; preserve data, escaping and safety. Verify focused RED/GREEN, build, lint and full tests. Commit identity: recorded in the delivery report after commit. Rollback: business HTML renderer and associated tests.
- [ ] EMAIL-3: inspect synthetic previews and send a real test to a confirmed recipient; verify appearance in a real email client. Recipient/send authorization details pending.

## Evidence and next step

Main starts at `cd170b8070afcd888f951066cfa4087ba0668927`. Feature branch: `feat/branded-business-emails`.
- Focused RED: 5 failed, 62 passed (67 total), before production changes.
- Focused GREEN: 67 passed; full unit suite: 27 files, 398 passed, zero skips.
- `npm.cmd run build`: passed. `npm.cmd run lint`: passed with two unchanged warnings in `test/sales-conflict.e2e-spec.ts` (unused resB and missing sort comparator).
- `npm.cmd run test:e2e`: 27 files, 570 passed, zero skips against isolated local `bazar_test`; no database reset/migration needed.
- `git diff --check`: passed. Shared HTML uses inline brand colors, system font fallbacks, fluid 600px table layout with Outlook conditional wrapper, and textual branding.
- Synthetic previews: `.tmp/branded-business-emails/{approval-request,business-approved,credentials-relay,credentials-backup}.html` (ignored, fake values, mocked Resend, no HTTP).
- Preview generation initially failed through tsx (`uv_os_get_passwd` ENOMEM); importing the unchanged compiled service through Node succeeded. Actual browser/client visual inspection remains pending.
- No Resend panel access, received headers, real test email, push or deployment completed. Inherited Node TLS warning was observed, not changed or used for remote requests.
- RDD status is unavailable (parent observed access denial); no native review run or approval inferred.

Next: parent visual preview review and confirmed recipient for a real test send. Engram mirror remains pending.
