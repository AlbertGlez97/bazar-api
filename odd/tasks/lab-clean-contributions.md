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

- [x] LC1 — Recheck target/mount, integrate both local main branches and preserve feature branches.
- [x] LC2 — Stop necessary deploy services; remove only selected postgres container/volume; recreate PostgreSQL; build/start only api/frontend and apply all migrations from zero via real entrypoint.
- [x] LC3 — Verify migration history, tables/indexes/FKs/forced RLS/runtime role and Contribution/ContributionReversal, empty operative data, Compose status/local HTTP.
- [ ] LC4 — Normal-flow business/member/device/product setup and Alberto800000/Adid400000 cent contributions; replay/persistence/correction and unchanged sales/income/margin; optional reliable browser offline proof. Stop for exact manual action if approval/credentials inaccessible without further authorization.
- [ ] LC5 — Backend/frontend lint, tests, typecheck/build, independent state/volume verification, final clean Git and sanitized report/email count.

## Checks and execution

TDD not applicable: operational reset with no new behavior; existing functional suites are mandatory. Backend npm.cmd run lint, npm.cmd test, npm.cmd run test:e2e, npx.cmd tsc --noEmit -p tsconfig.build.json, npm.cmd run build. Frontend npm.cmd run lint, npm.cmd run test:run -- --maxWorkers=2, npx.cmd vue-tsc -b, npm.cmd run build. Test suite uses existing isolated bazar-api_postgres_test, never deletes it. Source/credentials/config remain unchanged.

Run Docker through its existing local executable with explicit project/file/service names. Migration CLI migrate deploy then existing runtime-role provisioning, no db push/automatic seed. Record names/counts/status only; never dump inspect Env, full config/logs/email content. Forecast several minutes for image builds and full suites. Tracking-only commits stay on existing feat/finance-contributions and are fast-forwarded into main, no new feature or remote operation.

## Progress

LC1/LC2/LC3 runtime work complete. Both local main branches were fast-forward integrated by the parent before runtime work; feature branches retained. Only the authorized database volume was recreated; three preserved volumes are unchanged. Engram mirror odd/lab-clean-contributions/tasks, project bazar-api. Writer functional checks passed; parent independent state check and LC4 normal-flow/mail handoff remain pending.

## Runtime evidence (2026-10-04 UTC)

### Exact volume boundary

Docker desktop-linux endpoint verified local npipe. Immediately before removal: deploy-postgres-1 project deploy/service postgres, exact volume mount deploy_postgres_prod_data at /var/lib/postgresql/data; volume labels project deploy/volume postgres_prod_data matched. Stopped only api/frontend/postgres, removed only postgres service container and the exact volume, recreated postgres, rebuilt API/frontend. No down -v, prune, seed, db push or unrelated deletion.

| Volume | Before CreatedAt | After CreatedAt | Result |
|---|---|---|---|
| deploy_postgres_prod_data | 2026-09-30T00:16:52Z | 2026-10-04T22:36:52Z | Only authorized reset |
| deploy_api_uploads | 2026-09-30T00:16:52Z | 2026-09-30T00:16:52Z | Preserved |
| bazar-api_postgres_dev | 2026-09-23T02:34:53Z | 2026-09-23T02:34:53Z | Preserved |
| bazar-api_postgres_test | 2026-09-23T02:34:53Z | 2026-09-23T02:34:53Z | Preserved |

Initial PowerShell ErrorAction Stop treated Docker progress stderr as NativeCommandError; a bounded cached build/start rerun with captured progress verified exit0, with no repeated volume deletion. An initial /api/v1/health probe404 was replaced with the actual root endpoint; diagnostic quoting/path probes were corrected without changing configuration. No unresolved runtime failure.

### Fresh schema and runtime

Real entrypoint migrate-deploy/provision/start phases and all-migrations success marker verified from sanitized log booleans.21/21 current migration directories recorded as finished/non-rolled-back; no seed.17 public tables,42 indexes,23 foreign keys;14 tenant tables have ENABLE+FORCE RLS and one all-command USING/WITH CHECK contextId=current_setting('app.context_id',true) policy each. Global Account/BusinessRegistrationRequest and internal migration table have no tenant RLS, matching existing model.

Contribution has integer amountMinor with positive check, fixed MXN check, UUID id/member/actor/device, economic/received timestamptz, immutable fingerprint/creation receipt.3 indexes inclPK;3 restrictive member/device FKs. ContributionReversal4 indexes inclPK and unique original/replacement references;4 restrictive contribution/member/device FKs, reason nonblank and original!=replacement checks. Both forced RLS. Runtime bazar_app has rolsuper=false/rolbypassrls=false, no SELECT access to _prisma_migrations, existing finance DML grants.

All16 operative tables initially and after isolated suites remained0 rows: Abono,Account,AppSettings,BusinessRegistrationRequest,Contribution,ContributionReversal,CuotaPlaneada,Deuda,Deudor,Device,Incidencia,Member,Product,ProductAudit,Sale,SaleItem.

Migrations applied from zero:

- 20260923023515_init
- 20260923155500_auth_context
- 20260923162000_products_audit
- 20260923163000_product_image_path
- 20260923170000_sales_conflict_status
- 20260923180000_incidencias
- 20260923190000_commissions
- 20260923200000_deudas
- 20260924002500_sale_request_fingerprint
- 20260924010000_active_flags
- 20260924080000_multitenancy_context_columns
- 20260924081000_multitenancy_rls
- 20260924082000_business_registration
- 20260925100000_registration_person_fields
- 20260925120000_be12_team_devices
- 20260928031339_be13_sale_item_unit_cost
- 20260929120000_be15_deudas_cuotas_abono_inicial
- 20261001160000_installment_calendar_date
- 20261001180000_debt_client_idempotency
- 20261003090000_finance_contributions
- 20261003091000_contribution_reversals

### Local runtime and functional proof

Compose project deploy: postgres healthy, API/frontend up; loopback-only ports3100/8080. API GET/api/v1/200; auth/me401; unauthenticated contributions401; POSTauth/login emptybody400 with no credentials/email; frontend root/login200. APP_BASE_URL configured/non-loopback, unchanged; no external baked origin visited or browser authentication claimed.

- API lint exit0 with2 existing warnings test/sales-conflict.e2e-spec.ts; unit405/405 in28files; e2e609/609 in28files; typecheck/build exit0. E2E uses existing isolated testDB and mocks real email; deploy operativeDB remains empty.
- Frontend lint exit0; npm.cmd run test:run -- --maxWorkers=2 3221/3221 in184files (219.57s); vue-tsc/build exit0. Existing toast dynamic/static import and large-chunk build warnings. No formatter or source edit.
- No new logic/TDD cycle: operational validation only. No source/config/env edits, no remote/push/PR/branch deletion, no live mail or business flow. Email send count0.
- Runtime reset is irreversible for the removed authorized volume; other data/config preserved. Tracker-only commit is independently revertible without changing runtime/source.
- LC4 remains pending for separate parent-approved normal flow and bounded Resend/manual action; LC5 writer checks complete but independent state verification/final delivery remain pending.
- Memory mirror pending: latest runtime hook reported session registration unavailable; parent instructed agent-attributed writes to stop. Local tracker is authoritative; no memory configuration modification.
