-- BE-11 (part 2 of 2): Postgres Row Level Security, the *second* isolation
-- layer behind the Prisma tenant-isolation extension (src/database/
-- tenant.extension.ts). If a bug in application code ever bypassed the
-- extension (a new raw query, a service that forgot to run inside the
-- managed transaction wrapper, a future contributor unaware of the
-- convention), this is what stops one context's data from leaking into
-- another's response — enforced by Postgres itself, not by any code path
-- that can be skipped by mistake.
--
-- Every policy is written as:
--   current_setting('app.context_id', true) IS NULL
--   OR "contextId" = current_setting('app.context_id', true)
-- rather than a strict `"contextId" = current_setting(...)`, because this
-- single Postgres role is used by three different kinds of connections
-- that this migration cannot tell apart at the database level:
--   1. The running API, serving real HTTP traffic — this is the case that
--      matters for isolation, and it *always* sets `app.context_id` before
--      touching a scoped table (see PrismaService's `$transaction`
--      override and the extension's standalone-call wrapper), so the
--      strict branch of the OR is what actually applies to it.
--   2. `prisma/seed.ts` and the e2e/integration test suite, which both
--      connect directly (bypassing the Nest app and its middleware
--      entirely) and have always been written to pass an explicit
--      `contextId` themselves rather than relying on a session variable.
--      Blocking these outright would not add security (they already
--      supply the correct value by hand) — it would only break every
--      existing fixture and the seed script for no isolation benefit,
--      since nothing there ever mixes contexts by accident.
-- A connection that never sets `app.context_id` therefore is not
-- filtered by this policy — it is exactly as unrestricted as every
-- connection was before BE-11. This is a deliberate, documented scope
-- reduction: RLS here protects the *serving application's* connection
-- pool from an application-layer bug, not an arbitrary raw psql session.
-- Restricting that further would require a dedicated, lower-privileged
-- database role for the app (so a session that never identifies a tenant
-- has no access at all) — left as a follow-up once the test suite's
-- fixture strategy is ready to set the session variable itself instead of
-- relying on trusted direct access.
--
-- FORCE ROW LEVEL SECURITY still matters even with the permissive-when-
-- unset clause: without FORCE, Postgres exempts a table's *owning* role
-- from RLS entirely, even for a strict, session-var-set policy. Since the
-- app connects as the same role that owns these tables in this project's
-- single-database-user setup, FORCE is what makes the policy actually
-- apply to the app's own connection once it *has* set a context — without
-- it, the policy would silently never do anything for the one connection
-- it exists to constrain.
ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Product"
  USING (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true))
  WITH CHECK (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true));

ALTER TABLE "ProductAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductAudit" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProductAudit"
  USING (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true))
  WITH CHECK (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true));

ALTER TABLE "Sale" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Sale" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Sale"
  USING (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true))
  WITH CHECK (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true));

ALTER TABLE "SaleItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SaleItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SaleItem"
  USING (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true))
  WITH CHECK (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true));

ALTER TABLE "Incidencia" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Incidencia" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Incidencia"
  USING (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true))
  WITH CHECK (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true));

ALTER TABLE "Deudor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Deudor" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Deudor"
  USING (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true))
  WITH CHECK (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true));

ALTER TABLE "Deuda" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Deuda" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Deuda"
  USING (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true))
  WITH CHECK (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true));

ALTER TABLE "Abono" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Abono" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Abono"
  USING (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true))
  WITH CHECK (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true));

ALTER TABLE "AppSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AppSettings"
  USING (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true))
  WITH CHECK (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true));

ALTER TABLE "Member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Member" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Member"
  USING (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true))
  WITH CHECK (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true));

ALTER TABLE "Device" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Device" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Device"
  USING (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true))
  WITH CHECK (current_setting('app.context_id', true) IS NULL OR "contextId" = current_setting('app.context_id', true));

-- "Account" is deliberately NOT included here (and not in the Prisma
-- extension's scoped-model list either): resolving *which* contextId
-- applies to a request starts with looking up an Account by username/JWT
-- subject, before any contextId is known — an RLS policy on Account would
-- have nothing to filter by yet at that exact moment, and would block the
-- very query that establishes the tenant in the first place.
