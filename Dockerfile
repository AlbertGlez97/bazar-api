# syntax checked against Docker Desktop 29.8.0 / BuildKit
#
# Two stages:
#   builder  -> installs full deps (incl. devDependencies), generates the
#               Prisma client, compiles Nest to dist/
#   runtime  -> only what's needed to run `node dist/main`, but STILL with
#               devDependencies present (see note below on why).

# ---- builder ----
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
# Full install (incl. devDependencies): `prisma` (the CLI) and `typescript`
# are devDependencies but are required to generate the client and to build.
RUN npm ci

COPY . .

# prisma.config.ts resolves DATABASE_URL_MIGRATE/DATABASE_URL eagerly just to
# load the config file, even for `prisma generate` (which never actually
# connects to a database). This placeholder is only used to satisfy that
# resolution at build time in this discarded builder stage; the real
# DATABASE_URL is supplied at container start via docker-compose.prod.yml's
# env_file, not baked into the image.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

# IMPORTANT — order is not interchangeable:
# `prisma generate` MUST run before `npm run build` (`nest build`). The
# Prisma 7 client is generated as real .ts files under
# src/generated/prisma/** (schema.prisma: `output = "../src/generated/prisma"`),
# not prebuilt .js. tsconfig.json has rootDir "." (the whole repo) and
# outDir "./dist", so `nest build` only picks up src/generated/prisma/**
# if those .ts files already exist on disk when the compiler runs. Running
# build first would compile against a missing/stale generated client.
RUN npx prisma generate
RUN npm run build

# ---- runtime ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# Do NOT reinstall with `npm ci --omit=dev` here. `prisma` (the CLI used by
# `prisma migrate deploy` in docker-entrypoint.sh) is a devDependency, not a
# regular dependency — an --omit=dev install would delete it and break
# migrations at container start. Instead, copy the already-resolved
# node_modules (with devDependencies) straight from the builder stage.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./package.json

# PRODUCT_UPLOAD_DIR defaults to uploads/products (relative to process cwd,
# i.e. /app here). Created up front so the app/volume mount has somewhere to
# land even before the first upload. Mount a named volume over
# /app/uploads/products in docker-compose.prod.yml for persistence.
RUN mkdir -p uploads/products

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
