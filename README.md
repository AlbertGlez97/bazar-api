# Bazar backend: audited product catalog (BE-04)

Products are scoped to the authenticated account context. `unitPriceMinor` replaces
`salePriceMinor` with a data-preserving database rename; all amounts remain integer
MXN cents. Existing products stay in `legacy-unassigned`, not in a new account's catalog.

| Endpoint | Contract |
| --- | --- |
| `GET /products?search=...&page=1&limit=20` | JWT required; case-insensitive name search, items/total/page/limit. Limit 1-100; deterministic createdAt/id order. |
| `POST /products` | JWT, x-member-id and x-device-id; selected socio only. Required name, tipo, unitPriceMinor. cantidad requires initialStock; unica always uses 1, ignoring any supplied valid initialStock. |
| `PATCH /products/:id` | Selected socio only. Editable name, unitPriceMinor, category, purchaseCostMinor, supplier, notes. Optional metadata may be cleared with null. |
| `GET /products/:id/audit?page=1&limit=20` | Context-scoped audit snapshots with memberId, changedAt, old/new prices; JWT required. |
| `POST /products/:id/image` | Selected socio only; multipart field `image`, one file, maximum 5 MiB. Returns updated product with image URL. |

Optional product fields: category, purchaseCostMinor, supplier, notes; image is
set only through the upload endpoint, not by accepting arbitrary URLs. `tipo`,
`initialStock` and `stock` cannot be patched. No stock adjustment, sale, commission
or payment policy is implemented. Unknown request properties are rejected.

Create/edit/image audit and product updates commit together. Row locks serialize
edits so each audit captures the actual predecessor price. The selected actor's
current database role is checked, never trusted from request input. This remains
the approved shared-tablet selection model: a logged-in account can select a
same-context socio; it does not authenticate that person individually.

Pagination is offset-based, without a fixed global result truncation. Each response
has a consistent count/page; separate requests are **not** a catalog snapshot.
Inserts or edits during offline traversal may require a fresh download.

## Local product images

`StorageService.save(file)` returns `{ path, url }`; `getUrl(path)` derives the public URL and `remove(path)` handles cleanup. Product.imagePath stores only the key; product responses expose the computed `image` URL. By default normalized
files live in `uploads/products` (ignored by Git); `PRODUCT_UPLOAD_DIR` can point
to another dedicated directory. Static `/uploads/products/<random-uuid>.png`
URLs are **public without JWT**, not private image storage. Back up the image
directory separately from PostgreSQL.

Only content-detected PNG/JPEG/WebP with matching MIME, one frame and at most
16 million pixels are accepted. Sharp fully decodes and re-encodes to PNG,
stripping uploaded metadata/content; input and normalized output are capped at
5 MiB. Original filenames are ignored. SVG/HTML, corrupt data, MIME spoofing and
oversized files are rejected. Responses set nosniff and restrictive CSP headers.

Failed database/audit writes remove the newly saved file; cleanup failures are
logged for operator attention. Replaced old images are retained to avoid breaking
in-flight readers. There is no automatic orphan retention job or distributed
filesystem/database transaction; process crashes can leave orphan files.

Tests use an isolated temporary image directory and the guarded test database.
Use the existing migration and test commands below. See
[`odd/tasks/backend-e0-be04.md`](odd/tasks/backend-e0-be04.md) for verified evidence.

# Authentication and device context (BE-03)

BE-03 adds `POST /auth/login`, `GET /members` and `POST /devices/identify`.
No sale, commission or payment logic is implemented.

## Provision local access

Set `JWT_SECRET` to an independently generated random secret (at least 32 characters).
Set `SEED_CONTEXT_ID`, `SEED_USERNAME` and `SEED_PASSWORD` (at least 12 characters)
in your ignored `.env`; there are no default account credentials. Then run:

```sh
npx prisma generate
npx prisma migrate deploy
npx prisma db seed
```

The seed creates Alberto and Adid as `socio`, a shared tablet and two backup phones.
Stable member IDs and unique device identifiers make reruns idempotent. Reruns do
not reset passwords, move contexts or reauthorize revoked devices. The provisioning
context must not be `legacy-unassigned`; pre-existing BE-02 rows remain quarantined
there, and existing devices remain unauthorized until deliberately provisioned.
This seed provisions one installation, not a general multi-tenant onboarding API.

| Endpoint | Input | Access/result |
| --- | --- | --- |
| `POST /auth/login` | `{ "username": "...", "password": "..." }` | Argon2id verification; `{ accessToken, tokenType, expiresIn: 43200 }`, or 401 |
| `GET /members` | `Authorization: Bearer <token>` | Current account context only; `id`, `name`, `role` (`socio` or `colaborador`) |
| `POST /devices/identify` | Bearer token plus `{ "identifier": "shared-tablet", "name": "Shared tablet" }` | `{ deviceId }`; unknown, mismatched or revoked devices return 403 |

JWTs use HS256, issuer/audience checks and a 12-hour expiration (covers a full
bazaar-day session for an already-seed-authorized device without a refresh
token; see `src/auth/jwt.constants.ts`). Every request
reloads the active account, so deactivation and context changes apply immediately.
`ContextGuard` authenticates and checks `x-member-id` and `x-device-id` against the
account context and current device authorization. It is exported for future
business routes; selection/bootstrap routes intentionally require JWT only. Its
acceptance probe exists only in tests, not in the shipped API. Device identifiers
are not hardware attestation; these checks bind stored records, not physical devices.

Use HTTPS and request-rate limiting before public deployment. Refresh tokens,
password recovery, public signup and device enrollment are outside BE-03.

Tests use random fixture credentials in the isolated test database and remove only
their own rows. Run `npm run db:migrate:test`, `npm test`, `npm run test:e2e`,
`npm run build` and `npm run lint`. See the [BE-03 tracker](odd/tasks/backend-e0-be03.md)
for actual evidence and remaining prerequisites.

# Local persistence foundation (BE-02)

Requires Node 24 and Docker Compose. This slice adds persistence and money input
contracts; the existing `GET /` smoke route is unchanged. BE-03 authentication
is described above. Product operations and sale endpoints are not implemented.

## Start development

Copy `.env.example` to `.env`, replace the two example passwords and their matching
URL components, then run:

```sh
npm ci
docker compose up -d
docker compose ps
npx prisma validate
npx prisma migrate dev --name init
npx prisma generate
npm run build
npm start
```

The checked-in initial migration creates `Member`, `Device`, `Product`, `Sale`
and `SaleItem`. `Sale.id` is the client-generated UUID primary key: PostgreSQL
enforces uniqueness. `PrismaService` connects on initialization and disconnects
on application close; shutdown hooks are enabled.

## Run isolated tests

```sh
npm run db:migrate:test
npm test
npm run test:e2e
npm run lint
```

Development uses `bazar_dev` on localhost:5432 with the `postgres_dev` volume.
Tests use a separate PostgreSQL service, `bazar_test` on localhost:5433, with its
own user/password and `postgres_test` volume. Ports may be configured in `.env`;
keep URLs synchronized. Both Vitest configurations and the test migration command
require `DATABASE_URL_TEST`, reject development database names and nonlocal URLs,
and never fall back to `DATABASE_URL`. Test URLs cannot contain query overrides.
The integration smoke test inserts and removes only its own test member.

Stop containers with `docker compose down`; named volumes survive. Do not use
`down -v` unless intentionally deleting local data. Changing initialization
credentials does not change credentials in an existing volume.

On Windows PowerShell, use `npm.cmd` and `npx.cmd` if script policy blocks the
PowerShell shims. If Docker is not on PATH, invoke its installed `docker.exe`
with the same Compose arguments; no global PATH or execution-policy change is needed.

## Money contract

All persisted amounts are Prisma `Int` cents with a `Minor` suffix. Money helpers
use Dinero.js 2.0.2 and MXN: `toDinero`, `toMinorUnits`, `formatCurrency`.
`formatCurrency(12550)` returns exactly `$125.50`. Arithmetic uses Dinero operations,
not floating-point peso arithmetic. Conversion rejects noninteger/out-of-Int-range
amounts and incompatible currency/scale rather than rounding. DTOs require integer,
nonnegative product prices and cash received; signed intermediate money is allowed
without deciding future insufficient-cash policy.

Verification and remaining limitations are recorded in
[`odd/tasks/backend-e0-be02.md`](odd/tasks/backend-e0-be02.md).

## API documentation (Swagger)

`GET /docs` serves OpenAPI documentation generated from the existing controllers
and DTOs (`@nestjs/swagger`), but only when explicitly enabled — set
`ENABLE_API_DOCS=true` in `.env`. Otherwise the route does not exist at all
(plain 404, not a 401), so it never reveals that documentation exists in a
production deployment.

When enabled, `/docs` is additionally protected by its own HTTP Basic Auth
layer (`express-basic-auth`), configured with `DOCS_USER` and `DOCS_PASSWORD`
in `.env`. These credentials are **independent** from the JWT-based
socio/colaborador authentication used by the business API — they exist only
to gate documentation access and must not be reused as, or derived from,
business account credentials.

```
ENABLE_API_DOCS=true
DOCS_USER=some-docs-username
DOCS_PASSWORD=a-strong-unique-password
```

Requires `npm install` to pull in `@nestjs/swagger` and `express-basic-auth`
(added to `package.json`, not yet installed as of this commit).


---

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

To add it to this project:

```bash
$ npm install @nestjs/observe
```

Then follow the [setup guide](https://docs.nestjs.com/observability/overview) - it takes a single import and an app key.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil MyÅ›liwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
# bazar-api
