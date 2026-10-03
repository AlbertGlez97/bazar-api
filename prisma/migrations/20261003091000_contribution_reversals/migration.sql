
-- Correction only, never a refund/return of capital.
CREATE TABLE "ContributionReversal" (
  "id" UUID NOT NULL PRIMARY KEY,
  "contextId" TEXT NOT NULL,
  "contributionId" UUID NOT NULL REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "replacementContributionId" UUID REFERENCES "Contribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reason" TEXT NOT NULL CHECK (length(trim("reason")) > 0),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByMemberId" UUID NOT NULL REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdByAccountId" UUID NOT NULL,
  "deviceId" UUID NOT NULL REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "requestFingerprint" TEXT NOT NULL,
  "creationResponse" JSONB NOT NULL,
  CHECK ("replacementContributionId" IS NULL OR "replacementContributionId" <> "contributionId")
);
CREATE UNIQUE INDEX "ContributionReversal_contributionId_key" ON "ContributionReversal"("contributionId");
CREATE UNIQUE INDEX "ContributionReversal_replacementContributionId_key" ON "ContributionReversal"("replacementContributionId");
CREATE INDEX "ContributionReversal_contextId_occurredAt_id_idx" ON "ContributionReversal"("contextId", "occurredAt", "id");
ALTER TABLE "ContributionReversal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContributionReversal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ContributionReversal"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));
