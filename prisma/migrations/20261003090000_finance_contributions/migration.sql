-- Additive only: capital is not a sale, profit, ownership or repayment.
CREATE TABLE "Contribution" (
  "id" UUID NOT NULL PRIMARY KEY,
  "contextId" TEXT NOT NULL,
  "memberId" UUID NOT NULL REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0),
  "currency" CHAR(3) NOT NULL DEFAULT 'MXN' CHECK ("currency" = 'MXN'),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "note" TEXT,
  "createdByMemberId" UUID NOT NULL REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdByAccountId" UUID NOT NULL,
  "deviceId" UUID NOT NULL REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestFingerprint" TEXT NOT NULL,
  "creationResponse" JSONB NOT NULL
);
CREATE INDEX "Contribution_contextId_occurredAt_id_idx" ON "Contribution"("contextId", "occurredAt", "id");
CREATE INDEX "Contribution_contextId_memberId_occurredAt_id_idx" ON "Contribution"("contextId", "memberId", "occurredAt", "id");
ALTER TABLE "Contribution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contribution" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Contribution"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));
