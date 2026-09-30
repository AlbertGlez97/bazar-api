#!/bin/sh
set -e

# Order is not negotiable:
#   1. migrate deploy  -> applies pending Prisma migrations as the owner/
#                         migrator role (DATABASE_URL_MIGRATE). Safe to
#                         re-run: idempotent, applies only pending migrations.
#   2. provision role  -> (re)creates/updates the least-privileged runtime
#                         role (APP_DB_USER) and its grants. Must run AFTER
#                         migrate deploy: it revokes access to
#                         _prisma_migrations only if that table already
#                         exists, so running it first would silently skip
#                         that revoke on a brand new database.
#   3. start the app   -> only once the schema and the runtime role are
#                         ready.
# This runs on every container start (not just the first one) because
# `prisma migrate deploy` and provision-app-role.mjs are both idempotent by
# design — re-running them against an already-migrated/provisioned database
# is a no-op.

echo "[entrypoint] running prisma migrate deploy..."
npx prisma migrate deploy

echo "[entrypoint] provisioning the runtime db role (idempotent, safe to re-run)..."
node scripts/provision-app-role.mjs dev

echo "[entrypoint] starting the app..."
exec node dist/main
