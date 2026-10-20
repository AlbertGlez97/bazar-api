-- Additive: versioned profit-sharing rules and the approvals they need.
-- Nothing here changes how any existing amount is calculated.
CREATE TABLE "FinanceRuleSet" (
 "id" UUID PRIMARY KEY CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 "contextId" TEXT NOT NULL,
 "version" INTEGER NOT NULL CHECK ("version" >= 1),
 "status" TEXT NOT NULL CHECK ("status" IN ('borrador', 'pendiente', 'vigente', 'reemplazada', 'retirada')),
 "config" JSONB NOT NULL,
 "configHash" TEXT NOT NULL CHECK ("configHash" ~ '^[0-9a-f]{64}$'),
 "proposedByMemberId" UUID NOT NULL,
 "proposedByAccountId" UUID NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "submittedAt" TIMESTAMPTZ(3),
 "activatedAt" TIMESTAMPTZ(3),
 "supersededAt" TIMESTAMPTZ(3),
 "withdrawnAt" TIMESTAMPTZ(3),
 UNIQUE ("id", "contextId"),
 UNIQUE ("contextId", "version"),
 FOREIGN KEY ("proposedByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("proposedByAccountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- At most one proposal waiting and one rule set in force per business.
CREATE UNIQUE INDEX "FinanceRuleSet_one_pending" ON "FinanceRuleSet"("contextId") WHERE "status" = 'pendiente';
CREATE UNIQUE INDEX "FinanceRuleSet_one_in_force" ON "FinanceRuleSet"("contextId") WHERE "status" = 'vigente';
CREATE INDEX "FinanceRuleSet_contextId_status_idx" ON "FinanceRuleSet"("contextId", "status");

CREATE TABLE "FinanceRuleApproval" (
 "id" UUID PRIMARY KEY CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 "contextId" TEXT NOT NULL,
 "ruleSetId" UUID NOT NULL,
 "memberId" UUID NOT NULL,
 "approvedByAccountId" UUID NOT NULL,
 "approvedHash" TEXT NOT NULL CHECK ("approvedHash" ~ '^[0-9a-f]{64}$'),
 "approvedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("ruleSetId", "memberId"),
 FOREIGN KEY ("ruleSetId", "contextId") REFERENCES "FinanceRuleSet"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("memberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("approvedByAccountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "FinanceRuleApproval_contextId_ruleSetId_idx" ON "FinanceRuleApproval"("contextId", "ruleSetId");

CREATE TABLE "FinanceRuleReminder" (
 "id" UUID PRIMARY KEY CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 "contextId" TEXT NOT NULL,
 "ruleSetId" UUID NOT NULL,
 "memberId" UUID NOT NULL,
 "sentByMemberId" UUID NOT NULL,
 "emailSent" BOOLEAN NOT NULL DEFAULT false,
 "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("ruleSetId", "contextId") REFERENCES "FinanceRuleSet"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("memberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("sentByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "FinanceRuleReminder_ruleSetId_memberId_sentAt_idx" ON "FinanceRuleReminder"("ruleSetId", "memberId", "sentAt");
CREATE INDEX "FinanceRuleReminder_contextId_memberId_sentAt_idx" ON "FinanceRuleReminder"("contextId", "memberId", "sentAt");

-- Once submitted, what partners approve can never change; only the status moves,
-- along the allowed paths. Enforced here because the runtime role owns no REVOKE.
CREATE FUNCTION "finance_rule_set_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'finance rule sets cannot be deleted' USING ERRCODE = 'restrict_violation';
 END IF;
 IF NEW."id" <> OLD."id" OR NEW."contextId" <> OLD."contextId" OR NEW."version" <> OLD."version"
    OR NEW."proposedByMemberId" <> OLD."proposedByMemberId" OR NEW."proposedByAccountId" <> OLD."proposedByAccountId" THEN
  RAISE EXCEPTION 'finance rule set identity is immutable' USING ERRCODE = 'restrict_violation';
 END IF;
 IF OLD."status" <> 'borrador' AND (NEW."config" <> OLD."config" OR NEW."configHash" <> OLD."configHash") THEN
  RAISE EXCEPTION 'a submitted finance rule set cannot change' USING ERRCODE = 'restrict_violation';
 END IF;
 IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'borrador' AND NEW."status" IN ('pendiente', 'retirada'))
 OR (OLD."status" = 'pendiente' AND NEW."status" IN ('borrador', 'vigente'))
 OR (OLD."status" = 'vigente' AND NEW."status" = 'reemplazada')) THEN
  RAISE EXCEPTION 'invalid finance rule set transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "FinanceRuleSet_guard" BEFORE UPDATE OR DELETE ON "FinanceRuleSet" FOR EACH ROW EXECUTE FUNCTION "finance_rule_set_guard"();

-- An approval is recorded only for the exact hash of a pending rule set, never edited,
-- and removed only while that rule set can still be withdrawn.
CREATE FUNCTION "finance_rule_approval_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent RECORD;
BEGIN
 IF TG_OP = 'UPDATE' THEN
  RAISE EXCEPTION 'finance rule approvals are immutable' USING ERRCODE = 'restrict_violation';
 END IF;
 IF TG_OP = 'INSERT' THEN
  SELECT "status", "configHash" INTO parent FROM "FinanceRuleSet" WHERE "id" = NEW."ruleSetId" AND "contextId" = NEW."contextId";
  IF parent."status" IS DISTINCT FROM 'pendiente' OR parent."configHash" <> NEW."approvedHash" THEN
   RAISE EXCEPTION 'approval does not match a pending finance rule set' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
 END IF;
 SELECT "status" INTO parent FROM "FinanceRuleSet" WHERE "id" = OLD."ruleSetId" AND "contextId" = OLD."contextId";
 IF parent."status" NOT IN ('borrador', 'pendiente') THEN
  RAISE EXCEPTION 'approvals of a decided finance rule set are permanent' USING ERRCODE = 'restrict_violation';
 END IF;
 RETURN OLD;
END;
$$;
CREATE TRIGGER "FinanceRuleApproval_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FinanceRuleApproval" FOR EACH ROW EXECUTE FUNCTION "finance_rule_approval_guard"();

ALTER TABLE "FinanceRuleSet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceRuleSet" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FinanceRuleSet" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
ALTER TABLE "FinanceRuleApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceRuleApproval" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FinanceRuleApproval" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
ALTER TABLE "FinanceRuleReminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceRuleReminder" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FinanceRuleReminder" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
