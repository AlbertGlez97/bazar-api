# Runtime database role

The API, the seed and the tests must connect to PostgreSQL as a dedicated,
least-privileged role. The docker `POSTGRES_USER` (`bazar_dev`, `bazar_test`)
is only for migrations and provisioning.

## Why

Multi-tenancy (BE-11) relies on PostgreSQL row-level security (RLS): every
tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY` and a strict policy on
`app.context_id`. Postgres never applies RLS to a role that is `SUPERUSER` or
has `BYPASSRLS`, and `FORCE` does not change that (it only makes the policy
apply to the table owner). The docker `POSTGRES_USER` is a superuser, so with
that connection the database denies nothing and isolation would rest on the
application layer alone.

## Two connection levels

| Level | Role | Env vars | Used by |
| --- | --- | --- | --- |
| Runtime | `APP_DB_USER` / `APP_DB_TEST_USER`: `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, DML only | `DATABASE_URL` (dev), `DATABASE_URL_TEST` (test) | Nest app, `prisma db seed`, every unit/e2e test |
| Owner / migrator | The docker `POSTGRES_USER` (superuser or table owner) | `DATABASE_URL_MIGRATE` (dev), `DATABASE_URL_TEST_MIGRATE` (test) | `prisma migrate ...`, `npm run db:provision*`, `npm run db:migrate:test` |

If `DATABASE_URL_MIGRATE` / `DATABASE_URL_TEST_MIGRATE` are unset they fall back
to `DATABASE_URL` / `DATABASE_URL_TEST`, so an existing `.env` that still points
at the owner keeps working for migrations. `prisma.config.ts` uses the migrator
URL for the CLI; `src/database/prisma.service.ts` and `prisma/seed.ts` read
`DATABASE_URL` directly.

The runtime role gets: `CONNECT` on the database, `USAGE` on schema `public`,
`SELECT/INSERT/UPDATE/DELETE` on all tables and `USAGE/SELECT` on all sequences
(plus default privileges so tables created by future migrations are granted
automatically). It has no DDL rights and no access to `_prisma_migrations`.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `APP_DB_USER`, `APP_DB_PASSWORD` | Dev runtime role name and password (min. 16 characters) |
| `APP_DB_TEST_USER`, `APP_DB_TEST_PASSWORD` | Test runtime role name and password (min. 16 characters) |
| `DATABASE_URL`, `DATABASE_URL_TEST` | Runtime role URLs (same host, port and database as before) |
| `DATABASE_URL_MIGRATE`, `DATABASE_URL_TEST_MIGRATE` | Owner role URLs, migrations and provisioning only |

The runtime role must differ from the owner role; the provisioning script
refuses otherwise. See `.env.example` for the exact shape.

## Setup on a new machine

1. `docker compose up -d`
2. Copy `.env.example` to `.env`; replace every `replace_*` placeholder. The
   passwords inside the URLs must match `APP_DB_PASSWORD` / `APP_DB_TEST_PASSWORD`
   (and `POSTGRES_*` for the migrator URLs).
3. `npx prisma migrate dev` (owner connection, dev database)
4. `npm run db:provision` (creates or updates the dev runtime role)
5. `npx prisma db seed` (runs as the runtime role, under real RLS)
6. `npm run db:migrate:test` (migrates the test database as the owner, then
   provisions the test runtime role); `npm run db:provision:test` alone re-provisions it.

Provisioning is idempotent: re-running it rotates the password, forces the
role attributes and re-grants privileges. Run it after the first migration on a
fresh database so `_prisma_migrations` (created after the default privileges)
is revoked again; `db:migrate:test` already does this every time.

## Existing `.env` (upgrade)

Your `.env` currently points `DATABASE_URL` / `DATABASE_URL_TEST` at the owner role.

1. Copy the current values into the new variables: `DATABASE_URL_MIGRATE=<old DATABASE_URL>` and `DATABASE_URL_TEST_MIGRATE=<old DATABASE_URL_TEST>`.
2. Add `APP_DB_USER`, `APP_DB_PASSWORD`, `APP_DB_TEST_USER`, `APP_DB_TEST_PASSWORD` (passwords of at least 16 characters).
3. Change `DATABASE_URL` and `DATABASE_URL_TEST` to use the runtime role and its password (keep host, port and database name).
4. `npm run db:provision`, `npm run db:provision:test`, then `npx prisma migrate dev` and `npx prisma db seed`.

Provisioning falls back to the owner URL, so step 4 works even before step 1 if
`DATABASE_URL` still holds the owner; do step 1 before step 3.

## Verify

Connect as the runtime role (for the test database, `psql -h 127.0.0.1 -p 5433 -U <APP_DB_TEST_USER> -d bazar_test`):

```sql
SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
-- expected: <runtime role> | f | f

SELECT count(*) FROM "Member";                       -- 0, even though rows exist
BEGIN;
SELECT set_config('app.context_id', '<a real contextId>', true);
SELECT count(*) FROM "Member";                       -- only that context's rows
ROLLBACK;

CREATE TABLE ddl_probe (id int);                     -- permission denied for schema public
SELECT * FROM _prisma_migrations;                    -- permission denied
```

The automated equivalents are `test/runtime-role.e2e-spec.ts` and the
"raw query with no app.context_id" case in `test/rls-strict.e2e-spec.ts`.

## Startup guard

`PrismaService.onModuleInit` calls `assertRlsEnforcingRole`
(`src/database/rls-role-guard.ts`) right after connecting. It runs
`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user` and
aborts startup with an error that names the offending flag (`SUPERUSER`,
`BYPASSRLS` or both) and points here if the connection role bypasses RLS. There
is no environment flag to disable it. If the role cannot be inspected the app
also refuses to start.

## Notes

- Test DB safety is unchanged: `DATABASE_URL_TEST` and `DATABASE_URL_TEST_MIGRATE` must both be a local `bazar_test` database on the same host and port.
- Passwords are never printed by the provisioning script; it logs role names and actions only.
- Production: provision the runtime role the same way (owner connection in
  `DATABASE_URL_MIGRATE`, runtime role in `DATABASE_URL`). The owner URL is not needed by the running app.
