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

- [ ] EMAIL-1: document measured DNS findings, safe DMARC setup and reputation caveats. Runtime proof: DNS investigation supplied by the parent; documentation readback. Rollback: deliverability document only.
- [ ] EMAIL-2: share a branded table/inline shell across the business emails; preserve data, escaping and safety. Verify focused RED/GREEN, build, lint and full tests. Rollback: business HTML renderer and associated tests.
- [ ] EMAIL-3: inspect synthetic previews and send a real test to a confirmed recipient; verify appearance in a real email client. Recipient/send authorization details pending.

## Evidence and next step

Main starts at `cd170b8070afcd888f951066cfa4087ba0668927`. Feature branch: `feat/branded-business-emails`.
Next: deliverability documentation, then TDD for business HTML.
