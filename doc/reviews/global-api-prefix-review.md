# Native review: global `/api/v1` prefix

Complete record of the `gentle-ai` native review of the global-prefix work on `feat/backend-e0-be11-multitenancy`, kept here because the tool burns the review authority when the receipt is acknowledged and no longer serves the result. Everything under "Reviewer output" is reproduced verbatim from the tool output; the only text written by the maintainer session is under "Notes from the maintainer session".

**This review covers only the two global-prefix commits. BE-11 itself was not reviewed** (see "Scope and what was not reviewed").

## Summary

| Item | Value |
| --- | --- |
| Date | 2026-09-24 |
| Tool | `gentle-ai` 3.7.0, agent `claude-code`, contract `gentle-ai.review-integration/v2` |
| Commits reviewed | `646e291` (`fix(api): add global /api/v1 prefix`) and `7fb0781` (`docs(api): record the global prefix audit and verification`) |
| Risk | medium (configuration_change in .env.example) |
| Size | 9 files, 368 changed lines |
| Lens | review-reliability (one consolidated review; no security, resilience or readability lens ran) |
| Consent | Granted by the user for this candidate (answer `1`) |
| Outcome | **approved** |
| Findings | 2, both non-blocking (1 WARNING, 1 SUGGESTION); no correction opened |
| Lineage | `review-b42c400d3c8a09be` |
| Target identity | `sha256:e59d6a0822f2d1f5ca011fa9ca6c2448ed8468f2e118f026cbde3aea44db6a36` |
| Base tree / candidate tree | `7595823ee1c1e11f87ebf7a1816bc20f68e477d4` / `fdd9f40ad886831227b04fc0d7f92b1738e09953` |
| Reviewer result hash | `sha256:e13682e4af368e7f079ca3731b3ec17be594c446f819b9dc9ba8dfcc3811d751` |
| Receipt | acknowledged, authority `burned` |

## Scope and what was not reviewed

Changed paths in the reviewed candidate (from the frozen manifest):

- `.env.example` (modified)
- `README.md` (modified)
- `doc/reglas-de-negocio.md` (modified)
- `odd/tasks/global-api-prefix.md` (added)
- `src/app.module.ts` (modified)
- `src/business-registration/business-registration.service.spec.ts` (added)
- `src/business-registration/business-registration.service.ts` (modified)
- `src/main.ts` (modified)
- `test/business-registration.e2e-spec.ts` (modified)

- The whole-branch candidate against `main` (high risk, 133 files, 16041 lines) failed to start with `lens_context_budget_exceeded` (nothing was created) and a later identical-scope candidate was declined by the user. **BE-11 and the earlier BE-02 to BE-10 work were not reviewed by the native review**; doing so would require smaller candidates that fit the review context budget, each with its own consent.
- A first lineage for this same candidate was started from a preflight run without `--agent claude-code`, so its reviewer capture could not run; it was released with the user's maintainer authorization (`operator_disposition`, no results or findings discarded) and restarted correctly. It is not part of this result.

## Reviewer output

### Provider statement

> This review is approved and its receipt stands. Every finding listed here is non-blocking: none opened a correction, none reopens this review, and no correction transition is offered for this candidate. Treat them as separate later work, never as a reason to re-run review on this candidate.

### Findings

#### R3-bootstrap-capture-ordering (WARNING)

- Location: `test/business-registration.e2e-spec.ts:75-91`
- Lens: reliability
- Evidence class: inferential
- Causal disposition: introduced
- Provider disposition: informational (non-blocking)
- Proof references: `test/business-registration.e2e-spec.ts:75-91`, `test/business-registration.e2e-spec.ts:206-210`, `src/main.ts:9-13`

Claim:

> The e2e test runs the real bootstrap by dynamically importing the main module. It then removes the NestFactory.create spy and the Logger#warn spy in the finally block, as soon as the import promise resolves. The patch does not show whether the main module awaits bootstrap() at top level. If the module calls bootstrap() without awaiting it, the import resolves while setGlobalPrefix, static and docs configuration, and app.listen are still pending. Middleware registration, where the LegacyRouteConverter warning is logged, runs inside listen/init. So the warning can be logged after the spy is restored. The 'boots through main.ts without route-conversion warnings' test would then pass vacuously, and later requests could reach a server that has not finished listening. The task record says a RED run captured the warning, so the ordering holds today. That depends on microtask timing and is not guaranteed. Awaiting an explicit readiness signal, such as polling app.getHttpServer().listening or exporting and awaiting the bootstrap promise, would make the assertion deterministic.

#### R3-baseurl-case (SUGGESTION)

- Location: `src/business-registration/business-registration.service.ts:36-42`
- Lens: reliability
- Provider disposition: informational (non-blocking)
- Proof references: `src/business-registration/business-registration.service.ts:36-42`, `src/business-registration/business-registration.service.spec.ts:9-17`

Claim:

> baseUrl() removes a trailing '/api/v1' only when it matches exactly in lowercase. An APP_BASE_URL ending in '/API/v1' or '/api/v1?x' would still produce a doubled or malformed path. The unit spec covers only the lowercase forms. This is low risk because the .env.example comment tells operators to give the origin only.

### Evidence the reviewer cited

1. Inspected all 9 manifest paths in the supplied immutable patches.
2. src/main.ts:13 adds setGlobalPrefix before the static and docs configuration. test/business-registration.e2e-spec.ts:175-203 asserts that prefixed routes return 200/401/400, that unprefixed controller routes return 404, that OpenAPI paths carry the prefix, and that the /docs-json and /uploads/products mounts stay at the origin.
3. src/app.module.ts:41 changes the middleware registration to the optional wildcard. test/business-registration.e2e-spec.ts:212-226 shows through the real bootstrap that an authenticated prefixed request sees only its own tenant's product, with unique per-run context IDs, so the check is deterministic.
4. src/business-registration/business-registration.service.ts:35-43 normalizes APP_BASE_URL: it trims whitespace, treats blank as unset, and strips trailing slashes and a trailing /api/v1. src/business-registration/business-registration.service.spec.ts:9-47 covers those cases, including blank and undefined falling back to the PORT default.
5. The documentation hunks in README.md, doc/reglas-de-negocio.md and .env.example agree with the code's behavior: no legacy aliases, and APP_BASE_URL is origin-only.

### Receipt acknowledgement

```json
{
  "schema": "gentle-ai.review-acknowledged/v1",
  "operation": "review/acknowledge-approved",
  "action": "acknowledged",
  "lineage_id": "review-b42c400d3c8a09be",
  "target_identity": "sha256:e59d6a0822f2d1f5ca011fa9ca6c2448ed8468f2e118f026cbde3aea44db6a36",
  "consumed_revision": "sha256:5cba26fe9a8c1de0809c6ace4e8dd98de3b75d3451887add61553fb2e3b51267",
  "authority": "burned"
}
```

## Notes from the maintainer session

Written after the review; not reviewer output.

- **R3-bootstrap-capture-ordering.** The finding is conditional on `src/main.ts` not awaiting `bootstrap()`. `src/main.ts` ends with `await bootstrap();` (line 21), so the dynamic `import()` in the e2e resolves only after `app.listen` has finished and the stated premise does not hold; the test's RED run also captured the warning. The remaining true point is that the test relies on that top-level `await` staying in `main.ts`; if it were removed the test could pass vacuously. An explicit readiness assertion (for example `app.getHttpServer().listening`) would remove that dependency.
- **R3-baseurl-case.** Accurate: `baseUrl()` strips a trailing `/api/v1` in lowercase only. Low risk because `.env.example` asks for the server origin only.
- **Status at the time of writing:** neither finding has been addressed in code; the commits reviewed were pushed as they were (`ed80cba..e3c173c`). Any fix would be a new change outside this approval.
