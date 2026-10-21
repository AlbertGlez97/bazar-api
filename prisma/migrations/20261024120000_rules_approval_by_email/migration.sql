-- Profit-sharing rules are approved by EMAIL, one link per socio, instead of from a session.
-- Additive: new columns, new tables, new functions. The only existing rows touched are the
-- proposals still waiting under the old mechanism (see "Old mechanism" below) and the new
-- Member.correo backfill.

-- ───────────────────────── Member.correo ─────────────────────────
-- One address per person, unique across all businesses, always stored lower-cased. It is
-- separate from the login: approvals and confirmations go here.
ALTER TABLE "Member" ADD COLUMN "correo" TEXT CHECK ("correo" IS NULL OR ("correo" = lower("correo") AND length("correo") BETWEEN 3 AND 254));
CREATE UNIQUE INDEX "Member_correo_key" ON "Member"("correo");

-- Backfill. "Member" has FORCE ROW LEVEL SECURITY, which also binds the table owner when it
-- is neither a superuser nor BYPASSRLS: with no app.context_id the UPDATEs below would match
-- zero rows, silently. FORCE is lifted for these statements only and restored right after,
-- inside this same migration transaction (same technique as the BE-12 backfill).
ALTER TABLE "Member" NO FORCE ROW LEVEL SECURITY;

-- 1) A person created with POST /members got a login whose username IS their address.
--    Only usernames that are already lower-case (so two of them cannot collapse into one).
UPDATE "Member" m
SET "correo" = a."username"
FROM "Account" a
WHERE a."memberId" = m."id" AND a."contextId" = m."contextId"
  AND m."correo" IS NULL
  AND a."username" = lower(a."username")
  AND length(a."username") BETWEEN 5 AND 100
  AND a."username" !~ '[[:space:]]'
  AND length(a."username") - length(replace(a."username", '@', '')) = 1
  AND position('@' in a."username") > 1
  AND position('.' in substr(a."username", position('@' in a."username") + 1)) > 1
  AND right(a."username", 1) <> '.'
  AND NOT EXISTS (SELECT 1 FROM "Member" o WHERE o."correo" = a."username");

-- 2) A business with exactly ONE active socio gets the address the founder confirmed when
--    registering (the registration is only approved after that confirmation).
UPDATE "Member" m
SET "correo" = r."correo"
FROM "BusinessRegistrationRequest" r
WHERE r."createdContextId" = m."contextId"
  AND r."status" = 'aprobado'
  AND r."emailVerifiedAt" IS NOT NULL
  AND m."role" = 'socio' AND m."active" AND m."correo" IS NULL
  AND (SELECT count(*) FROM "Member" s WHERE s."contextId" = m."contextId" AND s."role" = 'socio' AND s."active") = 1
  AND r."correo" = lower(r."correo")
  AND length(r."correo") BETWEEN 5 AND 254
  AND r."correo" !~ '[[:space:]]'
  AND length(r."correo") - length(replace(r."correo", '@', '')) = 1
  AND position('@' in r."correo") > 1
  AND position('.' in substr(r."correo", position('@' in r."correo") + 1)) > 1
  AND right(r."correo", 1) <> '.'
  AND NOT EXISTS (SELECT 1 FROM "Member" o WHERE o."correo" = r."correo");

ALTER TABLE "Member" FORCE ROW LEVEL SECURITY;

-- ───────────────────────── rule set states ─────────────────────────
-- New states: en_revision (a socio objected) and descartada. 'retirada' stays valid for the
-- rows that already carry it: "withdraw" no longer exists, discard and modify replace it.
ALTER TABLE "FinanceRuleSet" DROP CONSTRAINT "FinanceRuleSet_status_check";
ALTER TABLE "FinanceRuleSet" ADD CONSTRAINT "FinanceRuleSet_status_check"
  CHECK ("status" IN ('borrador', 'pendiente', 'en_revision', 'vigente', 'reemplazada', 'descartada', 'retirada'));
-- Version this one was copied from (Modify), "what changed" (frozen when it is sent), and why
-- and when it was closed without being approved.
ALTER TABLE "FinanceRuleSet" ADD COLUMN "basedOnId" UUID;
ALTER TABLE "FinanceRuleSet" ADD COLUMN "changeSummary" JSONB CHECK ("changeSummary" IS NULL OR jsonb_typeof("changeSummary") = 'array');
ALTER TABLE "FinanceRuleSet" ADD COLUMN "inReviewAt" TIMESTAMPTZ(3);
ALTER TABLE "FinanceRuleSet" ADD COLUMN "discardedAt" TIMESTAMPTZ(3);
ALTER TABLE "FinanceRuleSet" ADD COLUMN "closedNote" TEXT CHECK ("closedNote" IS NULL OR length("closedNote") <= 300);
ALTER TABLE "FinanceRuleSet" ADD CONSTRAINT "FinanceRuleSet_basedOn_fkey"
  FOREIGN KEY ("basedOnId", "contextId") REFERENCES "FinanceRuleSet"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most ONE open proposal (waiting or in review) and one rule set in force per business.
DROP INDEX "FinanceRuleSet_one_pending";
CREATE UNIQUE INDEX "FinanceRuleSet_one_open" ON "FinanceRuleSet"("contextId") WHERE "status" IN ('pendiente', 'en_revision');

CREATE OR REPLACE FUNCTION "finance_rule_set_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'finance rule sets cannot be deleted' USING ERRCODE = 'restrict_violation';
 END IF;
 IF NEW."id" <> OLD."id" OR NEW."contextId" <> OLD."contextId" OR NEW."version" <> OLD."version"
    OR NEW."proposedByMemberId" <> OLD."proposedByMemberId" OR NEW."proposedByAccountId" <> OLD."proposedByAccountId"
    OR NEW."basedOnId" IS DISTINCT FROM OLD."basedOnId" THEN
  RAISE EXCEPTION 'finance rule set identity is immutable' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD."status" <> 'borrador' AND (NEW."config" <> OLD."config" OR NEW."configHash" <> OLD."configHash"
    OR NEW."changeSummary" IS DISTINCT FROM OLD."changeSummary") THEN
  RAISE EXCEPTION 'a submitted finance rule set cannot change' USING ERRCODE = 'restrict_violation';
 END IF;
 IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'borrador' AND NEW."status" IN ('pendiente', 'descartada'))
 OR (OLD."status" = 'pendiente' AND NEW."status" IN ('en_revision', 'vigente', 'descartada'))
 OR (OLD."status" = 'en_revision' AND NEW."status" = 'descartada')
 OR (OLD."status" = 'vigente' AND NEW."status" = 'reemplazada')) THEN
  RAISE EXCEPTION 'invalid finance rule set transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
 END IF;
 RETURN NEW;
END;
$$;

-- Old mechanism: proposals that were waiting for approval FROM A SESSION can no longer be
-- approved (there is one way now: the emailed link), so they are closed with a note. Their
-- approvals stay as history. "FinanceRuleSet" is FORCE row-level secured: lifted for this
-- statement only, as above.
ALTER TABLE "FinanceRuleSet" NO FORCE ROW LEVEL SECURITY;
UPDATE "FinanceRuleSet"
SET "status" = 'descartada', "discardedAt" = now(), "updatedAt" = now(),
    "closedNote" = 'Se descartó porque ahora las reglas se aprueban por correo. Propónganlas de nuevo.'
WHERE "status" = 'pendiente';
ALTER TABLE "FinanceRuleSet" FORCE ROW LEVEL SECURITY;

-- ───────────────────────── approvals ─────────────────────────
-- An approval now comes from an emailed link, not from an account.
ALTER TABLE "FinanceRuleApproval" ALTER COLUMN "approvedByAccountId" DROP NOT NULL;
ALTER TABLE "FinanceRuleApproval" ADD COLUMN "correo" TEXT;
ALTER TABLE "FinanceRuleApproval" ADD COLUMN "linkId" UUID;

-- ───────────────────────── tables ─────────────────────────
-- One emailed link per socio and proposal. Only the SHA-256 of the token is stored.
-- "correo" is the complete address it was sent to (shown masked on screen).
CREATE TABLE "FinanceRuleLink" (
 "id" UUID PRIMARY KEY CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 "contextId" TEXT NOT NULL,
 "ruleSetId" UUID NOT NULL,
 "memberId" UUID NOT NULL,
 "correo" TEXT NOT NULL CHECK ("correo" = lower("correo") AND length("correo") BETWEEN 3 AND 254),
 "tokenHash" CHAR(64) NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
 "kind" TEXT NOT NULL CHECK ("kind" IN ('envio', 'reenvio')),
 "sentByMemberId" UUID NOT NULL,
 "emailSent" BOOLEAN NOT NULL DEFAULT false,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "usedAt" TIMESTAMPTZ(3),
 "supersededAt" TIMESTAMPTZ(3),
 CHECK ("expiresAt" > "createdAt"),
 FOREIGN KEY ("ruleSetId", "contextId") REFERENCES "FinanceRuleSet"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("memberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("sentByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "FinanceRuleLink_ruleSetId_memberId_createdAt_idx" ON "FinanceRuleLink"("ruleSetId", "memberId", "createdAt");
CREATE INDEX "FinanceRuleLink_contextId_idx" ON "FinanceRuleLink"("contextId");
-- ENABLE without FORCE on purpose (same reason as "AccountInvitation"): the public page reads a
-- link by token hash BEFORE its tenant is known, through the SECURITY DEFINER functions below.
ALTER TABLE "FinanceRuleLink" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FinanceRuleLink" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));

ALTER TABLE "FinanceRuleApproval" ADD CONSTRAINT "FinanceRuleApproval_linkId_fkey"
  FOREIGN KEY ("linkId") REFERENCES "FinanceRuleLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- "No estoy de acuerdo": the reason is mandatory (1 to 500 characters), plain text.
CREATE TABLE "FinanceRuleObjection" (
 "id" UUID PRIMARY KEY CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 "contextId" TEXT NOT NULL,
 "ruleSetId" UUID NOT NULL,
 "memberId" UUID NOT NULL,
 "linkId" UUID NOT NULL REFERENCES "FinanceRuleLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "correo" TEXT NOT NULL,
 "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("ruleSetId", "memberId"),
 FOREIGN KEY ("ruleSetId", "contextId") REFERENCES "FinanceRuleSet"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("memberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "FinanceRuleObjection_contextId_ruleSetId_idx" ON "FinanceRuleObjection"("contextId", "ruleSetId");
ALTER TABLE "FinanceRuleObjection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceRuleObjection" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FinanceRuleObjection" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
CREATE FUNCTION "finance_rule_objection_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'finance rule objections are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "FinanceRuleObjection_guard" BEFORE UPDATE OR DELETE ON "FinanceRuleObjection" FOR EACH ROW EXECUTE FUNCTION "finance_rule_objection_guard"();

-- "Escribir mi correo": the address only becomes the member's after they open this link.
CREATE TABLE "MemberEmailConfirmation" (
 "id" UUID PRIMARY KEY CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 "contextId" TEXT NOT NULL,
 "memberId" UUID NOT NULL,
 "correo" TEXT NOT NULL CHECK ("correo" = lower("correo") AND length("correo") BETWEEN 3 AND 254),
 "tokenHash" CHAR(64) NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
 "requestedByAccountId" UUID NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "usedAt" TIMESTAMPTZ(3),
 "supersededAt" TIMESTAMPTZ(3),
 CHECK ("expiresAt" > "createdAt"),
 FOREIGN KEY ("memberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("requestedByAccountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "MemberEmailConfirmation_memberId_createdAt_idx" ON "MemberEmailConfirmation"("memberId", "createdAt");
ALTER TABLE "MemberEmailConfirmation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MemberEmailConfirmation" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));

-- ───────────────────────── functions ─────────────────────────
-- Activates a waiting proposal when EVERY active socio has approved it, replacing the rule set
-- in force. Called inside the caller's transaction (tenant already set). Returns whether it
-- activated. A socio who is no longer active does not count.
CREATE FUNCTION "finance_rule_set_settle"(p_context TEXT, p_rule_set UUID) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "FinanceRuleSet" s WHERE s."id" = p_rule_set AND s."contextId" = p_context AND s."status" = 'pendiente') THEN
  RETURN false;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM "Member" m WHERE m."contextId" = p_context AND m."role" = 'socio' AND m."active") THEN
  RETURN false;
 END IF;
 IF EXISTS (
  SELECT 1 FROM "Member" m
  WHERE m."contextId" = p_context AND m."role" = 'socio' AND m."active"
    AND NOT EXISTS (SELECT 1 FROM "FinanceRuleApproval" a WHERE a."ruleSetId" = p_rule_set AND a."contextId" = p_context AND a."memberId" = m."id")
 ) THEN
  RETURN false;
 END IF;
 UPDATE "FinanceRuleSet" SET "status" = 'reemplazada', "supersededAt" = now(), "updatedAt" = now()
  WHERE "contextId" = p_context AND "status" = 'vigente';
 UPDATE "FinanceRuleSet" SET "status" = 'vigente', "activatedAt" = now(), "updatedAt" = now()
  WHERE "id" = p_rule_set AND "contextId" = p_context;
 RETURN true;
END;
$$;

-- Public page, step 1: read-only; never consumes the link. Returns what the page shows, and
-- only for a live link (not used, not replaced, not expired) of an active socio whose
-- proposal is still open. "state" is 'pendiente' (can answer) or 'en_revision' (cannot).
CREATE FUNCTION "finance_rule_link_lookup"(p_token_hash TEXT)
RETURNS TABLE ("state" TEXT, "contextId" TEXT, "version" INTEGER, "config" JSONB, "changeSummary" JSONB,
  "memberName" TEXT, "proposerName" TEXT, "expiresAt" TIMESTAMPTZ, "submittedAt" TIMESTAMPTZ,
  "approvedNames" TEXT[], "waitingNames" TEXT[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE l RECORD; s RECORD; prev TEXT; who TEXT; proposer TEXT; approved TEXT[]; waiting TEXT[];
BEGIN
 SELECT k."contextId", k."ruleSetId", k."memberId", k."expiresAt" INTO l
 FROM "FinanceRuleLink" k
 WHERE k."tokenHash" = p_token_hash AND k."usedAt" IS NULL AND k."supersededAt" IS NULL AND k."expiresAt" > now();
 IF NOT FOUND THEN RETURN; END IF;
 prev := current_setting('app.context_id', true);
 PERFORM set_config('app.context_id', l."contextId", true);
 SELECT st."status", st."version", st."config", st."changeSummary", st."submittedAt", st."proposedByMemberId" INTO s
 FROM "FinanceRuleSet" st WHERE st."id" = l."ruleSetId" AND st."contextId" = l."contextId";
 SELECT m."name" INTO who FROM "Member" m
 WHERE m."id" = l."memberId" AND m."contextId" = l."contextId" AND m."active" AND m."role" = 'socio';
 IF s."status" IS NULL OR s."status" NOT IN ('pendiente', 'en_revision') OR who IS NULL THEN
  PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
  RETURN;
 END IF;
 SELECT p."name" INTO proposer FROM "Member" p WHERE p."id" = s."proposedByMemberId" AND p."contextId" = l."contextId";
 SELECT COALESCE(array_agg(m."name" ORDER BY m."createdAt", m."id") FILTER (WHERE a."id" IS NOT NULL), '{}'),
        COALESCE(array_agg(m."name" ORDER BY m."createdAt", m."id") FILTER (WHERE a."id" IS NULL), '{}')
 INTO approved, waiting
 FROM "Member" m
 LEFT JOIN "FinanceRuleApproval" a ON a."memberId" = m."id" AND a."ruleSetId" = l."ruleSetId" AND a."contextId" = m."contextId"
 WHERE m."contextId" = l."contextId" AND m."role" = 'socio' AND m."active";
 PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
 RETURN QUERY SELECT s."status", l."contextId", s."version", s."config", s."changeSummary", who,
   COALESCE(proposer, 'Un socio'), l."expiresAt", s."submittedAt", approved, waiting;
END;
$$;

-- Public page, step 2: records the answer. Lock order is ALWAYS rule set first, then link (the
-- application locks them in the same order), so two answers racing for the last approval
-- cannot deadlock, and the proposal becomes "vigente" exactly once. One row back with the
-- outcome, no row for every failure so callers cannot tell the reasons apart.
-- Outcomes: 'aprobada', 'vigente' (this approval was the last one), 'objetada', 'en_revision'
-- (someone objected before: nothing is recorded).
CREATE FUNCTION "finance_rule_link_respond"(p_token_hash TEXT, p_decision TEXT, p_reason TEXT, p_record_id UUID)
RETURNS TABLE ("outcome" TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE l RECORD; s RECORD; prev TEXT; result TEXT;
BEGIN
 IF p_decision NOT IN ('approve', 'object') THEN RETURN; END IF;
 SELECT k."id", k."contextId", k."ruleSetId", k."memberId", k."correo" INTO l
 FROM "FinanceRuleLink" k WHERE k."tokenHash" = p_token_hash;
 IF NOT FOUND THEN RETURN; END IF;
 prev := current_setting('app.context_id', true);
 PERFORM set_config('app.context_id', l."contextId", true);
 BEGIN
  SELECT st."status", st."configHash" INTO s FROM "FinanceRuleSet" st
   WHERE st."id" = l."ruleSetId" AND st."contextId" = l."contextId" FOR UPDATE;
  PERFORM 1 FROM "FinanceRuleLink" k
   WHERE k."id" = l."id" AND k."usedAt" IS NULL AND k."supersededAt" IS NULL AND k."expiresAt" > now() FOR UPDATE;
  IF NOT FOUND OR s."status" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "Member" m WHERE m."id" = l."memberId" AND m."contextId" = l."contextId" AND m."active" AND m."role" = 'socio') THEN
   PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
   RETURN;
  END IF;
  IF s."status" = 'en_revision' THEN
   result := 'en_revision';
  ELSIF s."status" <> 'pendiente' THEN
   PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
   RETURN;
  ELSIF p_decision = 'approve' THEN
   INSERT INTO "FinanceRuleApproval" ("id", "contextId", "ruleSetId", "memberId", "approvedByAccountId", "approvedHash", "correo", "linkId")
   VALUES (p_record_id, l."contextId", l."ruleSetId", l."memberId", NULL, s."configHash", l."correo", l."id");
   UPDATE "FinanceRuleLink" SET "usedAt" = now() WHERE "id" = l."id";
   result := CASE WHEN "finance_rule_set_settle"(l."contextId", l."ruleSetId") THEN 'vigente' ELSE 'aprobada' END;
  ELSE
   INSERT INTO "FinanceRuleObjection" ("id", "contextId", "ruleSetId", "memberId", "linkId", "correo", "reason")
   VALUES (p_record_id, l."contextId", l."ruleSetId", l."memberId", l."id", l."correo", btrim(p_reason));
   UPDATE "FinanceRuleLink" SET "usedAt" = now() WHERE "id" = l."id";
   UPDATE "FinanceRuleSet" SET "status" = 'en_revision', "inReviewAt" = now(), "updatedAt" = now()
    WHERE "id" = l."ruleSetId" AND "contextId" = l."contextId";
   result := 'objetada';
  END IF;
 EXCEPTION WHEN unique_violation OR check_violation THEN
  PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
  RETURN;
 END;
 PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
 RETURN QUERY SELECT result;
END;
$$;

-- "Escribir mi correo", page step 1: read-only. Live link of an active member without an
-- address yet, and an address nobody else has taken.
CREATE FUNCTION "member_email_confirmation_lookup"(p_token_hash TEXT)
RETURNS TABLE ("memberName" TEXT, "correo" TEXT, "expiresAt" TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c RECORD; prev TEXT; who TEXT;
BEGIN
 SELECT k."contextId", k."memberId", k."correo", k."expiresAt" INTO c
 FROM "MemberEmailConfirmation" k
 WHERE k."tokenHash" = p_token_hash AND k."usedAt" IS NULL AND k."supersededAt" IS NULL AND k."expiresAt" > now();
 IF NOT FOUND THEN RETURN; END IF;
 prev := current_setting('app.context_id', true);
 PERFORM set_config('app.context_id', c."contextId", true);
 SELECT m."name" INTO who FROM "Member" m
 WHERE m."id" = c."memberId" AND m."contextId" = c."contextId" AND m."active" AND m."role" = 'socio' AND m."correo" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "Member" o WHERE o."correo" = c."correo");
 PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
 IF who IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT who, c."correo", c."expiresAt";
END;
$$;

-- Page step 2: the address becomes the member's, once. "notify" lists the OTHER active socios
-- that already have an address, so the application can tell them who registered.
CREATE FUNCTION "member_email_confirm"(p_token_hash TEXT)
RETURNS TABLE ("correo" TEXT, "memberName" TEXT, "contextId" TEXT, "memberId" UUID, "notify" JSONB)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c RECORD; prev TEXT; who TEXT; others JSONB;
BEGIN
 SELECT k."id", k."contextId", k."memberId", k."correo" INTO c
 FROM "MemberEmailConfirmation" k
 WHERE k."tokenHash" = p_token_hash AND k."usedAt" IS NULL AND k."supersededAt" IS NULL AND k."expiresAt" > now()
 FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 prev := current_setting('app.context_id', true);
 PERFORM set_config('app.context_id', c."contextId", true);
 BEGIN
  -- The OUT columns share names with these columns: every reference is qualified by an alias.
  UPDATE "Member" mm SET "correo" = c."correo"
   WHERE mm."id" = c."memberId" AND mm."contextId" = c."contextId" AND mm."active" AND mm."role" = 'socio' AND mm."correo" IS NULL
   RETURNING mm."name" INTO who;
  IF who IS NULL THEN
   PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
   RETURN;
  END IF;
  UPDATE "MemberEmailConfirmation" kk SET "usedAt" = now() WHERE kk."id" = c."id";
  UPDATE "MemberEmailConfirmation" kk SET "supersededAt" = now()
   WHERE kk."memberId" = c."memberId" AND kk."contextId" = c."contextId" AND kk."id" <> c."id" AND kk."usedAt" IS NULL AND kk."supersededAt" IS NULL;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', m."name", 'correo', m."correo") ORDER BY m."createdAt", m."id"), '[]'::jsonb)
  INTO others
  FROM "Member" m
  WHERE m."contextId" = c."contextId" AND m."role" = 'socio' AND m."active" AND m."correo" IS NOT NULL AND m."id" <> c."memberId";
 EXCEPTION WHEN unique_violation THEN
  PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
  RETURN;
 END;
 PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
 RETURN QUERY SELECT c."correo", who, c."contextId", c."memberId", others;
END;
$$;
