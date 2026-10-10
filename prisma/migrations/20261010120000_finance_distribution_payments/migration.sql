-- Phase 6: REAL payments recorded against participants of a distribution agreement.
-- La Marchanta does not move money; these rows record what was actually paid.
-- Payments and their reversals are immutable: a mistake is corrected by a
-- reversal followed by a new payment, never by editing or deleting a row.

-- FK target for the payment -> participant composite reference. Index only; the
-- participant table stays immutable (the primary key is already unique on a subset).
ALTER TABLE "DistributionAgreementParticipant" ADD CONSTRAINT "DistributionAgreementParticipant_agreementId_memberId_contextId_key" UNIQUE ("agreementId", "memberId", "contextId");

CREATE TABLE "DistributionPayment" (
 "id" UUID NOT NULL,
 "contextId" TEXT NOT NULL,
 "agreementId" UUID NOT NULL,
 "participantMemberId" UUID NOT NULL,
 "amountMinor" INTEGER NOT NULL,
 "currency" CHAR(3) NOT NULL,
 "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "note" TEXT,
 "createdByMemberId" UUID NOT NULL,
 "createdByAccountId" UUID NOT NULL,
 "deviceId" UUID NOT NULL,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "requestFingerprint" TEXT NOT NULL,
 "creationResponse" JSONB NOT NULL,
 CONSTRAINT "DistributionPayment_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "DistributionPayment_id_uuidv7_check" CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT "DistributionPayment_amountMinor_range_check" CHECK ("amountMinor" > 0 AND "amountMinor" <= 2147483647),
 CONSTRAINT "DistributionPayment_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
 CONSTRAINT "DistributionPayment_note_length_check" CHECK ("note" IS NULL OR length("note") <= 1000),
 CONSTRAINT "DistributionPayment_requestFingerprint_check" CHECK (length("requestFingerprint") > 0),
 CONSTRAINT "DistributionPayment_id_contextId_key" UNIQUE ("id", "contextId"),
 CONSTRAINT "DistributionPayment_agreementId_contextId_fkey" FOREIGN KEY ("agreementId", "contextId") REFERENCES "DistributionAgreement"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "DistributionPayment_participant_fkey" FOREIGN KEY ("agreementId", "participantMemberId", "contextId") REFERENCES "DistributionAgreementParticipant"("agreementId", "memberId", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "DistributionPayment_createdByMemberId_contextId_fkey" FOREIGN KEY ("createdByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "DistributionPayment_createdByAccountId_contextId_fkey" FOREIGN KEY ("createdByAccountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "DistributionPayment_deviceId_contextId_fkey" FOREIGN KEY ("deviceId", "contextId") REFERENCES "Device"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DistributionPayment_contextId_agreementId_participantMemberId_idx" ON "DistributionPayment"("contextId", "agreementId", "participantMemberId");
CREATE INDEX "DistributionPayment_contextId_receivedAt_id_idx" ON "DistributionPayment"("contextId", "receivedAt", "id");

CREATE TABLE "DistributionPaymentReversal" (
 "id" UUID NOT NULL,
 "contextId" TEXT NOT NULL,
 "paymentId" UUID NOT NULL,
 "reason" TEXT NOT NULL,
 "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdByMemberId" UUID NOT NULL,
 "createdByAccountId" UUID NOT NULL,
 "deviceId" UUID NOT NULL,
 "requestFingerprint" TEXT NOT NULL,
 "creationResponse" JSONB NOT NULL,
 CONSTRAINT "DistributionPaymentReversal_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "DistributionPaymentReversal_id_uuidv7_check" CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT "DistributionPaymentReversal_reason_length_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
 CONSTRAINT "DistributionPaymentReversal_id_distinct_check" CHECK ("id" <> "paymentId"),
 CONSTRAINT "DistributionPaymentReversal_requestFingerprint_check" CHECK (length("requestFingerprint") > 0),
 CONSTRAINT "DistributionPaymentReversal_paymentId_key" UNIQUE ("paymentId"),
 CONSTRAINT "DistributionPaymentReversal_paymentId_contextId_key" UNIQUE ("paymentId", "contextId"),
 CONSTRAINT "DistributionPaymentReversal_paymentId_contextId_fkey" FOREIGN KEY ("paymentId", "contextId") REFERENCES "DistributionPayment"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "DistributionPaymentReversal_createdByMemberId_contextId_fkey" FOREIGN KEY ("createdByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "DistributionPaymentReversal_createdByAccountId_contextId_fkey" FOREIGN KEY ("createdByAccountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "DistributionPaymentReversal_deviceId_contextId_fkey" FOREIGN KEY ("deviceId", "contextId") REFERENCES "Device"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DistributionPaymentReversal_contextId_occurredAt_id_idx" ON "DistributionPaymentReversal"("contextId", "occurredAt", "id");

ALTER TABLE "DistributionPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DistributionPayment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DistributionPayment" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
ALTER TABLE "DistributionPaymentReversal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DistributionPaymentReversal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DistributionPaymentReversal" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));

-- Immutability: triggers reject any change (the runtime role keeps UPDATE for
-- SELECT ... FOR UPDATE row locks, which do not fire UPDATE triggers).
CREATE FUNCTION "distribution_payment_reject_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'distribution payments are immutable (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "DistributionPayment_immutable" BEFORE UPDATE OR DELETE ON "DistributionPayment" FOR EACH ROW EXECUTE FUNCTION "distribution_payment_reject_change"();
CREATE TRIGGER "DistributionPaymentReversal_immutable" BEFORE UPDATE OR DELETE ON "DistributionPaymentReversal" FOR EACH ROW EXECUTE FUNCTION "distribution_payment_reject_change"();
