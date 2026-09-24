-- BE-11 (part 2 of 2): Postgres Row Level Security, the *second* isolation
-- layer behind the Prisma tenant-isolation extension (src/database/
-- tenant.extension.ts). If a bug in application code ever bypassed the
-- extension (a new raw query, a service that forgot to run inside the
-- managed transaction wrapper, a future contributor unaware of the
-- convention), this is what stops one context's data from leaking into
-- another's response — enforced by Postgres itself, not by any code path
-- that can be skipped by mistake.
--
-- Every policy is written strictly:
--   "contextId" = current_setting('app.context_id', true)
-- with NO "OR current_setting(...) IS NULL" escape hatch. A connection
-- that never sets `app.context_id` sees/writes NOTHING on any of these
-- tables — `current_setting(..., true)` returns NULL when unset, and
-- `"contextId" = NULL` evaluates to NULL (not true) for every row, so the
-- policy denies by default rather than falling back to "allow everything"
-- the moment a connection forgets to identify its tenant. A prior version
-- of this migration used an "IS NULL OR ..." permissive fallback to keep
-- prisma/seed.ts and every existing e2e fixture (both of which connect
-- directly, bypassing the Nest app and its middleware) working without
-- changes; that fallback defeated the entire purpose of a second,
-- independent isolation layer (a real isolation bug in the application
-- layer would have silently degraded RLS to a no-op instead of being
-- caught by it), so it was removed. `prisma/seed.ts` and the e2e suite
-- were updated instead (see their own files) to explicitly set
-- `app.context_id` themselves before touching any scoped table, exactly
-- as a real authenticated request does via the Prisma extension's
-- `$transaction` override — there is no code path in this project, seed
-- or test included, that is allowed to touch a tenant-scoped row without
-- first identifying which tenant it is acting as.
--
-- FORCE ROW LEVEL SECURITY still matters here: without FORCE, Postgres
-- exempts a table's *owning* role from RLS entirely, even for a strict
-- policy. Since the app connects as the same role that owns these tables
-- in this project's single-database-user setup, FORCE is what makes the
-- policy actually apply to the app's own connection — without it, the
-- policy would silently never do anything for the one connection it
-- exists to constrain.
ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Product"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

ALTER TABLE "ProductAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductAudit" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProductAudit"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

ALTER TABLE "Sale" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Sale" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Sale"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

ALTER TABLE "SaleItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SaleItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SaleItem"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

ALTER TABLE "Incidencia" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Incidencia" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Incidencia"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

ALTER TABLE "Deudor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Deudor" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Deudor"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

ALTER TABLE "Deuda" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Deuda" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Deuda"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

ALTER TABLE "Abono" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Abono" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Abono"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

ALTER TABLE "AppSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AppSettings"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

ALTER TABLE "Member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Member" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Member"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

ALTER TABLE "Device" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Device" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Device"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

-- "Account" is deliberately NOT included here (and not in the Prisma
-- extension's scoped-model list either): resolving *which* contextId
-- applies to a request starts with looking up an Account by username/JWT
-- subject, before any contextId is known — an RLS policy on Account would
-- have nothing to filter by yet at that exact moment, and would block the
-- very query that establishes the tenant in the first place.
