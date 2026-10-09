-- Phase 5.5: immutable distribution agreements created from a simulation.
-- An agreement is a frozen record, not a payment, withdrawal, debt or obligation.
CREATE TABLE "DistributionAgreement" (
 "id" UUID PRIMARY KEY CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 "contextId" TEXT NOT NULL,
 "folio" TEXT NOT NULL CHECK ("folio" ~ '^AC-[0-9]{4}-[0-9]{5,}$'),
 "periodFrom" DATE NOT NULL,
 "periodTo" DATE NOT NULL,
 "requestedAmountMinor" INTEGER NOT NULL CHECK ("requestedAmountMinor" > 0),
 "partnerShareBps" INTEGER NOT NULL CHECK ("partnerShareBps" BETWEEN 0 AND 10000),
 "workShareBps" INTEGER NOT NULL CHECK ("workShareBps" BETWEEN 0 AND 10000),
 "workBasis" TEXT NOT NULL CHECK ("workBasis" IN ('WORK_SHIFTS', 'KNOWN_MINUTES')),
 "partnerMode" TEXT NOT NULL DEFAULT 'EQUAL' CHECK ("partnerMode" = 'EQUAL'),
 "currency" CHAR(3) NOT NULL DEFAULT 'MXN' CHECK ("currency" = 'MXN'),
 "financialStatus" TEXT NOT NULL CHECK ("financialStatus" IN ('complete', 'partial')),
 "potentiallyAvailableMinor" INTEGER NOT NULL CHECK ("potentiallyAvailableMinor" >= "requestedAmountMinor"),
 "partnerPoolMinor" INTEGER NOT NULL CHECK ("partnerPoolMinor" >= 0),
 "workPoolMinor" INTEGER NOT NULL CHECK ("workPoolMinor" >= 0),
 "distributedMinor" INTEGER NOT NULL CHECK ("distributedMinor" >= 0),
 "undistributedMinor" INTEGER NOT NULL CHECK ("undistributedMinor" >= 0),
 "algorithmVersion" INTEGER NOT NULL CHECK ("algorithmVersion" >= 1),
 "title" TEXT NOT NULL CHECK (length(btrim("title")) BETWEEN 1 AND 120),
 "note" TEXT CHECK (length("note") <= 1000),
 "replacesAgreementId" UUID,
 "createdByMemberId" UUID NOT NULL,
 "createdByMemberName" TEXT NOT NULL,
 "createdByAccountId" UUID NOT NULL,
 "deviceId" UUID NOT NULL,
 "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "requestFingerprint" TEXT NOT NULL,
 "snapshotFingerprint" TEXT NOT NULL,
 "warningsSnapshot" JSONB NOT NULL,
 "creationResponse" JSONB NOT NULL,
 UNIQUE ("id", "contextId"),
 UNIQUE ("contextId", "folio"),
 UNIQUE ("replacesAgreementId", "contextId"),
 CHECK ("periodFrom" >= DATE '0001-01-01' AND "periodTo" <= DATE '9999-12-31' AND "periodFrom" < "periodTo"),
 CHECK ("partnerShareBps" + "workShareBps" = 10000),
 CHECK ("partnerPoolMinor" + "workPoolMinor" = "requestedAmountMinor"),
 CHECK ("distributedMinor" + "undistributedMinor" = "requestedAmountMinor"),
 CHECK ("replacesAgreementId" IS NULL OR "replacesAgreementId" <> "id"),
 FOREIGN KEY ("replacesAgreementId", "contextId") REFERENCES "DistributionAgreement"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("createdByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("createdByAccountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("deviceId", "contextId") REFERENCES "Device"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DistributionAgreement_contextId_receivedAt_id_idx" ON "DistributionAgreement"("contextId", "receivedAt", "id");
CREATE INDEX "DistributionAgreement_contextId_periodFrom_periodTo_id_idx" ON "DistributionAgreement"("contextId", "periodFrom", "periodTo", "id");

CREATE TABLE "DistributionAgreementParticipant" (
 "agreementId" UUID NOT NULL,
 "contextId" TEXT NOT NULL,
 "memberId" UUID NOT NULL,
 "memberName" TEXT NOT NULL,
 "role" TEXT NOT NULL CHECK ("role" IN ('socio', 'colaborador')),
 "isActive" BOOLEAN NOT NULL,
 "partnerEligible" BOOLEAN NOT NULL,
 "partnerAmountMinor" INTEGER NOT NULL CHECK ("partnerAmountMinor" >= 0),
 "workUnits" INTEGER NOT NULL CHECK ("workUnits" >= 0),
 "shiftCount" INTEGER NOT NULL CHECK ("shiftCount" >= 0),
 "knownMinutes" INTEGER NOT NULL CHECK ("knownMinutes" >= 0),
 "unknownDurationCount" INTEGER NOT NULL CHECK ("unknownDurationCount" >= 0),
 "workAmountMinor" INTEGER NOT NULL CHECK ("workAmountMinor" >= 0),
 "totalMinor" INTEGER NOT NULL CHECK ("totalMinor" >= 0),
 PRIMARY KEY ("agreementId", "memberId"),
 CHECK ("partnerAmountMinor" + "workAmountMinor" = "totalMinor"),
 FOREIGN KEY ("agreementId", "contextId") REFERENCES "DistributionAgreement"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("memberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DistributionAgreementParticipant_contextId_memberId_idx" ON "DistributionAgreementParticipant"("contextId", "memberId");

CREATE TABLE "DistributionAgreementReversal" (
 "id" UUID PRIMARY KEY CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 "contextId" TEXT NOT NULL,
 "agreementId" UUID NOT NULL UNIQUE,
 "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
 "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdByMemberId" UUID NOT NULL,
 "createdByAccountId" UUID NOT NULL,
 "deviceId" UUID NOT NULL,
 "requestFingerprint" TEXT NOT NULL,
 "creationResponse" JSONB NOT NULL,
 UNIQUE ("agreementId", "contextId"),
 CHECK ("id" <> "agreementId"),
 FOREIGN KEY ("agreementId", "contextId") REFERENCES "DistributionAgreement"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("createdByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("createdByAccountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("deviceId", "contextId") REFERENCES "Device"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DistributionAgreementReversal_contextId_occurredAt_id_idx" ON "DistributionAgreementReversal"("contextId", "occurredAt", "id");

-- Gapless per-context, per-year folio sequence (the only mutable table here).
CREATE TABLE "DistributionAgreementCounter" (
 "contextId" TEXT NOT NULL,
 "year" INTEGER NOT NULL CHECK ("year" BETWEEN 2000 AND 9999),
 "lastNumber" INTEGER NOT NULL CHECK ("lastNumber" >= 0),
 PRIMARY KEY ("contextId", "year")
);

ALTER TABLE "DistributionAgreement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DistributionAgreement" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DistributionAgreement" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
ALTER TABLE "DistributionAgreementParticipant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DistributionAgreementParticipant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DistributionAgreementParticipant" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
ALTER TABLE "DistributionAgreementReversal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DistributionAgreementReversal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DistributionAgreementReversal" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
ALTER TABLE "DistributionAgreementCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DistributionAgreementCounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DistributionAgreementCounter" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));

-- Immutability: the runtime role is re-granted UPDATE/DELETE by the provisioner
-- on every start, so REVOKE is unreliable; triggers reject any change instead.
CREATE FUNCTION "distribution_agreement_reject_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'distribution agreements are immutable (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "DistributionAgreement_immutable" BEFORE UPDATE OR DELETE ON "DistributionAgreement" FOR EACH ROW EXECUTE FUNCTION "distribution_agreement_reject_change"();
CREATE TRIGGER "DistributionAgreementParticipant_immutable" BEFORE UPDATE OR DELETE ON "DistributionAgreementParticipant" FOR EACH ROW EXECUTE FUNCTION "distribution_agreement_reject_change"();
CREATE TRIGGER "DistributionAgreementReversal_immutable" BEFORE UPDATE OR DELETE ON "DistributionAgreementReversal" FOR EACH ROW EXECUTE FUNCTION "distribution_agreement_reject_change"();
