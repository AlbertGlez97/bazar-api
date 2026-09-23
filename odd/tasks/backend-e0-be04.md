# BE-04: Context-scoped product catalog and audited images

Implement product create/edit/list with socio-only writes, transactional audit, and validated local image storage while preserving all uncommitted BE-03 work.

## Scope and decisions
- Rename Product.salePriceMinor to unitPriceMinor without data loss. Int cents throughout; MXN helpers unchanged except DTO field rename.
- Scope catalog and audit by authenticated account context; unassigned legacy products remain isolated.
- Selected database Member.role socio may mutate, colaborador may read. Selection uses the shared-tablet trust model, not individual authentication.
- Create unica with stock forced to 1 even when another valid initial stock is supplied; cantidad requires nonnegative integer initial stock. Type, initial/current stock are immutable through PATCH; no restocking/sales policy.
- Audit creation, metadata/price edits and image replacement atomically with actor, timestamps and old/new snapshots. Serialize edits with a product-row lock so old prices reflect the true predecessor.
- Images: separate multipart endpoint; max 5 MiB, actual PNG/JPEG/WebP decode, MIME consistency and safe PNG re-encoding, random filename. Public static URLs are not private storage. Retain old files for in-flight readers; remove a newly written file when database mutation fails.
- Contract correction: StorageService.save returns `{ path, url }`, getUrl derives a URL from the key. Product.imagePath persists only the key; product responses compute image URL and omit imagePath. Follow-up migration `20260923163000_product_image_path` preserves existing local image references and fails closed on unexpected references. Historical audit snapshots remain unchanged.
- No sale, commission or payment endpoints. No TDD (explicit user BE-04 policy); functional tests required.

## Tasks
- [x] BE04-1: Product/audit schema, safe migration and scoped transactional catalog.
- [x] BE04-2: Independent disk storage and guarded image upload/public static serving.
- [x] BE04-3: Acceptance, migration preservation, rollback/concurrency and upload tests; documentation and evidence.
- [ ] BE04-4: Parent independent verification and delivery decision before any commit.

## Checks
`npx.cmd prisma validate`, `npx.cmd prisma generate`, reviewed migration/deploy (no reset), `npm.cmd run db:migrate:test`, `npm.cmd test`, `npm.cmd run test:e2e`, `npm.cmd run build`, `npm.cmd run lint`.
Acceptance: roles/auth/context isolation; stock/type/Minor validation; audit actor/old/new prices; rollback/concurrent predecessor; insensitive search and deterministic pagination; valid image bytes/static URL, malformed/spoofed/oversize images, no unauthorized orphan, database-failure cleanup. Tests use only isolated test DB and a temporary upload directory.

## Observed verification (2026-09-23)
| Command / scenario | Result |
| --- | --- |
| `npx.cmd prisma validate`; `npx.cmd prisma generate` | Passed, Prisma 7.10.0 preserved |
| `npx.cmd prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --output prisma/migrations/20260923162000_products_audit/migration.sql` | Generated SQL reviewed; destructive inferred drop/add replaced with safe RENAME COLUMN before applying |
| `npx.cmd prisma migrate deploy` | Applied products_audit migration to bazar_dev without reset |
| `npm.cmd run db:migrate:test` | Applied same migration to bazar_test; repeat has no pending migrations |
| Follow-up image-path migration via `npx.cmd prisma migrate deploy` and `npm.cmd run db:migrate:test` | Passed on dev/test; replay smoke confirms existing `/uploads/products/<key>` becomes `<key>` without losing reference |
| `npx.cmd prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | No difference; exit 0 |
| `node .tmp/be04-migration-smoke.mjs` | Prior migrations plus existing Product row replayed in test-only schema/transaction; price 12550, stock 4, initialStock 7 and identity preserved, legacy context isolated; rolled back |
| `npm.cmd test` | 30 tests passed; prior unit cases preserved with approved price-field rename |
| `npm.cmd run test:e2e` | 40 tests passed: prior 17 plus 23 product cases |
| `npm.cmd run build`; `npm.cmd run lint` | Passed after normalization, no newly reported lint warnings |
| `git diff --check` | Passed |

E2E evidence includes two concurrent price edits whose audit chain links each actual predecessor; injected audit failure rolls back both create and edit; rejected foreign-context requests; valid PNG bytes stored and served with nosniff; replacement retains old file; MIME spoof/HTML/SVG/truncated PNG/oversize/missing image rejected; collaborator/foreign uploads leave no file; injected database failure removes the new file. Per-test temporary directories and own-context rows are removed. Public static behavior is exercised through the same configureStaticStorage helper used in main.
Correction verification also asserts unica supplied stock 0/2/Int-max is normalized to 1 while DTO validation remains active, database imagePath equals the saved key, and response image is the static URL rather than the stored path. Final checks: 30 unit and 40 e2e pass; build/lint, schema validate/generate and zero-diff schema check pass. No commit/push.

Resolved diagnostics: explicit Multer type augmentation was needed because tsconfig restricts ambient types; initial build failed before that fix. Existing broad Vitest globs discovered ignored snapshot copies and duplicated unit tests; constrained discovery to src/test rather than excluding failed business tests. Final totals above exclude snapshots. Source mutating formatters ran before final checks. Existing Prisma noninteractive migrate-dev limitation was already established in BE-03; supported reviewed diff/deploy used without repeating destructive recovery. No dependency upgrades or native review activation were attempted. The existing npm audit advisories remain; this work does not claim they are fixed.

Limitations: shared-tablet socio selection is not personal reauthentication; public image URLs are intentionally unauthenticated. Offset pagination across requests is not a snapshot. Replaced files are retained; crashes or cleanup failures can leave orphan files, with cleanup errors logged. Image output is normalized PNG, not byte-identical to uploaded JPEG/WebP. Required JWT/dev seed credentials remain the BE-03 operator prerequisite. No BE-05 behavior added.

## Delivery and recovery
- Parent owns commit decision. `delivery_strategy: ask-on-risk`; forecast 900-1200 authored lines including tests/docs (generated migration/client/lock excluded). No commit/push authorized now.
- Branch `feat/backend-e0-be04`, retaining dirty BE-03. Ignored `.tmp/be04-before` snapshots distinguish BE-04 edits from pre-existing changes. Do not blanket-stage or revert.
- Rollback only BE-04 code/config and forward-reviewed schema changes; preserve existing rows, BE-03 and stored image files. Disk and database are not a single atomic resource; cleanup failures must be visible.
- Progress: implementation and requested checks complete. No commits/pushes. Parent independent verification and delivery decision remain pending. BE-04-specific diff is measured against `.tmp/be04-before`, not Git main (which would include BE-03). Use `node .tmp/be04-diff-report.mjs` for exact current authored additions/deletions excluding lock/generated migration/client. Engram topic `odd/backend-e0-be04/tasks`; locator `odd/tasks/backend-e0-be04.md`.
