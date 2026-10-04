# Clean local lab: capital contributions

## Authorized scope

Integrate feat/finance-contributions into local main by fast-forward in both repositories. Rebuild the existing local deploy Compose stack from current migrations and test normal business/member/device/product/contribution flows. No push, external deployment, branch deletion, Cloudflare modification, application feature changes, .env modification or unrelated volume deletion.

## Exact destructive boundary

- Docker context: desktop-linux, local named pipe.
- Compose file: deploy/docker-compose.prod.yml; project deploy.
- PostgreSQL service postgres; container deploy-postgres-1.
- ONLY deletable volume: deploy_postgres_prod_data, mounted at /var/lib/postgresql/data, verified before deletion.
- MUST preserve deploy_api_uploads, bazar-api_postgres_dev, bazar-api_postgres_test, repository files, branches and configuration.
- Do not use compose down -v, volume prune, db push, broad deletion or database seed shortcuts.

## Email boundary

User explicitly authorizes existing lab Resend integration solely for test-business approval, test-user credentials and necessary authentication/activation. ONLY recipient: current APPROVAL_NOTIFICATION_EMAIL (also test-user email). Do not change credentials/recipient or print keys, tokens, passwords, .env values or sensitive email bodies. Keep an exact bounded send count and purpose; stop at necessary manual email action. No mailbox/other service access is implied.

## Tasks and proof

- [ ] LC1 — Recheck target/mount, integrate both local main branches and preserve feature branches.
- [ ] LC2 — Stop necessary deploy services; remove only selected postgres container/volume; recreate PostgreSQL; build/start only api/frontend and apply all migrations from zero via real entrypoint.
- [ ] LC3 — Verify migration history, tables/indexes/FKs/forced RLS/runtime role and Contribution/ContributionReversal, empty operative data, Compose status/local HTTP.
- [ ] LC4 — Normal-flow business/member/device/product setup and Alberto800000/Adid400000 cent contributions; replay/persistence/correction and unchanged sales/income/margin; optional reliable browser offline proof. Stop for exact manual action if approval/credentials inaccessible without further authorization.
- [ ] LC5 — Backend/frontend lint, tests, typecheck/build, independent state/volume verification, final clean Git and sanitized report/email count.

## Checks and execution

TDD not applicable: operational reset with no new behavior; existing functional suites are mandatory. Backend npm.cmd run lint, npm.cmd test, npm.cmd run test:e2e, npx.cmd tsc --noEmit -p tsconfig.build.json, npm.cmd run build. Frontend npm.cmd run lint, npm.cmd run test:run -- --maxWorkers=2, npx.cmd vue-tsc -b, npm.cmd run build. Test suite uses existing isolated bazar-api_postgres_test, never deletes it. Source/credentials/config remain unchanged.

Run Docker through its existing local executable with explicit project/file/service names. Migration CLI migrate deploy then existing runtime-role provisioning, no db push/automatic seed. Record names/counts/status only; never dump inspect Env, full config/logs/email content. Forecast several minutes for image builds and full suites. Tracking-only commits stay on existing feat/finance-contributions and are fast-forwarded into main, no new feature or remote operation.

## Progress

Initial inventory and FF checks complete. User saw and reconfirmed exact volume; four original volumes exist. No deletion/integration yet. Engram mirror odd/lab-clean-contributions/tasks, project bazar-api. Next: LC1/LC2 through bounded runtime executor, then verification and normal-flow mail handoff.
