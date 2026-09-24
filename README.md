# Bazar API — BE-02 through BE-09

NestJS 12 / PostgreSQL 16 backend for a shared-device bazaar: products, cash
sales, incident review, commission calculations, reports, and single-product debts.
Money is integer **MXN cents** (`12550` means `$125.50`), calculated with Dinero.js 2.

## Run locally

Prerequisites: Node.js 24, npm, and a running Docker Desktop Linux engine.
PowerShell users should use `npm.cmd` and `npx.cmd` instead of blocked .ps1 shims.

1. Copy `.env.example` to `.env`; replace the development/test passwords in
   both PostgreSQL variables and their matching URLs. Set an independent random
   `JWT_SECRET` (at least 32 characters). Never commit `.env`.
2. Start infrastructure, install, and create the database schema:

   ```sh
   docker compose up -d
   docker compose ps
   npm install
   npx prisma generate
   npx prisma migrate dev
   ```

   The committed migrations cover BE-02–BE-09. Do not reset a database to resolve
   drift; inspect the migration history and back up its data first.

3. Set `SEED_CONTEXT_ID`, `SEED_USERNAME`, and a `SEED_PASSWORD` of at least
   12 characters, then provision the installation:

   ```sh
   npx prisma db seed
   npm run start:dev
   ```

   Seed creates Alberto and Adid as socios, one account, and authorized devices
   `shared-tablet`, `alberto-backup-phone`, `adid-backup-phone`. It uses stable
   identities: repeating it does not duplicate rows, reset passwords, or
   reauthorize revoked devices. It fails closed on missing credentials or
   conflicting context ownership. This is one installation, not a tenant
   provisioning API. Colaborador creation has no public endpoint yet.

For compiled execution: `npm run build`, then `npm run start:prod`.
The default address is `http://localhost:3000`. `GET /` is the original
Hello World route, not a readiness probe. Prisma connects during startup and
disconnects when Nest closes; shutdown hooks are enabled.

## Environment reference

| Variable                                            | Meaning                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PORT`                                              | HTTP port, default 3000.                                                                                         |
| `DATABASE_URL`                                      | Development/runtime PostgreSQL URL; required.                                                                    |
| `DATABASE_URL_TEST`                                 | Separate local URL ending in `/bazar_test`; required by test tooling, never falls back to development.           |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Development container initialization; defaults for user/db are bazar_dev; password required.                     |
| `POSTGRES_PORT`                                     | Local development port, default 5432.                                                                            |
| `POSTGRES_TEST_USER`, `POSTGRES_TEST_PASSWORD`      | Test container initialization; default user bazar_test; password required. Database name is fixed bazar_test.    |
| `POSTGRES_TEST_PORT`                                | Local test port, default 5433.                                                                                   |
| `JWT_SECRET`                                        | Required independent signing secret, minimum 32 characters. Tokens expire after 12 hours; no refresh-token flow. |
| `SEED_CONTEXT_ID`, `SEED_USERNAME`, `SEED_PASSWORD` | Required only for seed; never hardcode real credentials.                                                         |
| `ENABLE_API_DOCS`                                   | Only exact `true` registers API documentation; otherwise absent/404.                                             |
| `DOCS_USER`, `DOCS_PASSWORD`                        | Independent Basic credentials, required when documentation is enabled.                                           |
| `PRODUCT_UPLOAD_DIR`                                | Local images directory; absent or blank uses `uploads/products`.                                                 |
| `NODE_ENV`                                          | Test tooling sets this internally to test; no application behavior currently branches on it.                     |

Docker exposes both databases on loopback only. Named volumes `postgres_dev`
and `postgres_test` are independent. Changing container initialization variables
does not change credentials already stored in an existing volume. Do not run
`docker compose down -v` unless you intend to destroy the stored data.

## Verify against the isolated test database

```sh
npm run db:migrate:test
npm run build
npm run lint
npm test
npm run test:e2e
```

The migration runner and both Vitest configurations require a local
`DATABASE_URL_TEST` with database name `bazar_test`, no URL query/hash, and
a different database name from development. E2E fixtures use unique contexts;
product-image tests use temporary storage. Migrations are explicit, not
automatically run by every test invocation. Never point tests at shared data.

TDD policy: disabled for scaffolding/auth/catalog (BE-02–04); enabled for business
rules from BE-05 onward. Verification evidence and known gaps are recorded in
[the verification report](odd/tasks/backend-e0-be09-verification.md).

## Authentication and request context

`POST /auth/login` accepts `username` and `password`, verifies Argon2id hashes,
and returns a JWT. Protected routes require `Authorization: Bearer <token>`.
`GET /members` lists same-context socios and colaboradores.
`POST /devices/identify` accepts a known device identifier/name and rejects
unknown, unauthorized, or cross-context devices.

Context-protected operations additionally require `x-member-id` and
`x-device-id` UUID headers. The account, selected member, and authorized device
must belong to the same context. Socio-only operations check the stored role.
**This is shared-tablet selection, not personal authentication**: a logged-in
account can select a same-context socio without a PIN. Do not present this as
proof of the individual operator's identity.

## Modules and routes

| Module      | Routes and permissions                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Products    | JWT: `GET /products`, `GET /products/:id/audit`. Selected socio: `POST /products`, `PATCH /products/:id`, `POST /products/:id/image`. |
| Sales       | Selected member/device: `POST /sales`. JWT: `GET /sales/:id`. Selected socio: `GET /sales`.                                           |
| Incidents   | Selected socio: `GET /incidencias`, `GET /incidencias/:id`, `PATCH /incidencias/:id/resolver`.                                        |
| Commissions | Selected socio: `GET /commissions`, `PATCH /settings/commission-rate`, `PATCH /members/:id/commission-rate`.                          |
| Reports     | Selected socio: `GET /reports/sales-by-period`, `GET /reports/sales-by-member`.                                                       |
| Debts       | Selected socio: `POST /deudas`, `GET /deudas`, `GET /deudas/:id`. Any selected member/device: `POST /deudas/:id/abonos`.              |

### Products and images

Create requires `name`, `tipo` (`unica` or `cantidad`), `unitPriceMinor`.
Cantidad requires `initialStock`; unica forces it to 1 even when another valid
integer is supplied. Optional metadata: category, purchaseCostMinor, supplier,
notes. PATCH edits metadata/prices, not tipo/stock/initialStock.
Creation and edits have transactional actor/snapshot audit; row locks serialize
predecessor prices. Catalog search is case-insensitive, with page/limit
pagination (limit at most 100), deterministic createdAt/id ordering, and no
cross-request snapshot promise.

Images use multipart field `image`, one file, maximum 5 MiB. Actual PNG/JPEG/WebP
content must match the declared MIME. Sharp decodes and re-encodes a single-frame
image as PNG, with a 16-million-pixel limit. Filenames are generated, not trusted.
Storage persists a path/key and exposes an image URL through `StorageService`.
The static `/uploads/products/` URLs are **public without JWT**: images are not
private data. Failed database updates remove newly saved files; replaced files
are retained for existing readers, and crash-orphan cleanup remains operational work.

### Cash sales and incidents

The client supplies a stable sale UUID, memberId/deviceId matching the selected
headers, occurredAt, currency MXN, cashReceivedMinor, and items
(productId/quantity). Prices are read from PostgreSQL, not trusted from the client.
Stock, totals, change, items, and sale commit atomically. Insufficient cash or
stock already absent on the initial read rejects the complete request.

Identical normalized resends return 200; new rows return 201; changed identity
payloads return 409. Client prices are excluded from identity because they are
not authoritative. A SHA-256 normalized request fingerprint preserves attempted
items even for newly rejected conflicts. Historical rejected rows lack that
evidence and fail closed with 409 on resend; no history is invented or deleted.

A genuine concurrent stock loser is persisted as `rechazada_por_conflicto`
with an Incidencia, without inventory changes. A sequential request arriving
after stock is already zero still returns 400, not a saved offline conflict.
Future occurredAt or more than two days old adds a date incident without
blocking an otherwise valid sale. Socios resolve incidents with notes; resolution
does not refund, restock, or alter sales automatically.

### Commissions and reports

Commission rates are basis points (1000 = 10%). Colaborador-specific nullable
overrides take precedence over the per-context global rate; missing global rate
means 0. Only completed sales count, even with pending incidents. Dinero scaled
multiplication rounds half-up to cents. This calculates commission, not payment.

Commission queries accept both from/to or neither (current Sunday–Saturday week);
reports require a date range. receivedAt is the time reference. Date-only values
cover the whole business day at the implementation's fixed UTC-06:00 offset;
full ISO instants retain their meaning. Historical timezone changes are not modeled.

### Debts and payments

Fiado and apartado both reserve stock immediately for one product/quantity.
Creation accepts exactly one existing deudorId or inline deudor
(nombre, optional telefono/notas). Server prices determine totalMinor.
Positive integer montoMinor payments cannot exceed the remaining balance;
serialized payments derive saldada when fully covered. Debt payments are not
Sale rows and do not enter sales reports/commissions. No debt cancellation,
multi-item debt, or offline debt reconciliation is implemented.

## API documentation

With `ENABLE_API_DOCS` absent/false, `/docs`, `/docs-json`, and `/docs-yaml`
return 404. When enabled, all three require independent HTTP Basic credentials:
missing/wrong credentials return 401; valid credentials return 200. Missing
configured credentials fail startup. Use HTTPS outside localhost; Basic auth
does not encrypt credentials. Business API JWT authorization remains separate.
Swagger reflects current annotations; not every DTO property has a complete
OpenAPI annotation, so source DTO validation remains authoritative.

## Scope and limitations

Offline queueing/catalog download belongs to a future client, not this backend.
No automatic conflict resolution, discounts, cancellations, commission payouts,
object storage, or personal member PINs are implemented.
The current business reference is [doc/reglas-de-negocio.md](doc/reglas-de-negocio.md);
older planning documents are historical context. See the verification report
for observed tests, dependency advisories, and unresolved edge cases.
