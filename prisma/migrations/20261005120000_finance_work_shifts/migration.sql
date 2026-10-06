-- Additive work facts. Composite references prevent mixed-tenant edges even under raw writes.
CREATE UNIQUE INDEX "Member_id_contextId_key" ON "Member"("id", "contextId");
CREATE UNIQUE INDEX "Device_id_contextId_key" ON "Device"("id", "contextId");
CREATE UNIQUE INDEX "Account_id_contextId_key" ON "Account"("id", "contextId");
CREATE TABLE "WorkShift" (
 "id" UUID PRIMARY KEY,
 "contextId" TEXT NOT NULL,
 "memberId" UUID NOT NULL,
 "workDate" DATE NOT NULL,
 "minutes" INTEGER CHECK ("minutes" > 0),
 "note" TEXT CHECK (length("note") <= 1000),
 "createdByMemberId" UUID NOT NULL,
 "createdByAccountId" UUID NOT NULL,
 "deviceId" UUID NOT NULL,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "requestFingerprint" TEXT NOT NULL,
 "creationResponse" JSONB NOT NULL,
 UNIQUE ("id", "contextId"),
 FOREIGN KEY ("memberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("createdByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("createdByAccountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("deviceId", "contextId") REFERENCES "Device"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "WorkShift_contextId_workDate_id_idx" ON "WorkShift"("contextId", "workDate", "id");
CREATE INDEX "WorkShift_contextId_memberId_workDate_id_idx" ON "WorkShift"("contextId", "memberId", "workDate", "id");
CREATE TABLE "WorkShiftReversal" (
 "id" UUID PRIMARY KEY,
 "contextId" TEXT NOT NULL,
 "workShiftId" UUID NOT NULL UNIQUE,
 "replacementWorkShiftId" UUID UNIQUE,
 "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
 "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdByMemberId" UUID NOT NULL,
 "createdByAccountId" UUID NOT NULL,
 "deviceId" UUID NOT NULL,
 "requestFingerprint" TEXT NOT NULL,
 "creationResponse" JSONB NOT NULL,
 FOREIGN KEY ("workShiftId", "contextId") REFERENCES "WorkShift"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("replacementWorkShiftId", "contextId") REFERENCES "WorkShift"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("createdByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("createdByAccountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("deviceId", "contextId") REFERENCES "Device"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CHECK ("id" <> "workShiftId" AND ("replacementWorkShiftId" IS NULL OR ("replacementWorkShiftId" <> "workShiftId" AND "replacementWorkShiftId" <> "id")))
);
CREATE INDEX "WorkShiftReversal_contextId_occurredAt_id_idx" ON "WorkShiftReversal"("contextId", "occurredAt", "id");
ALTER TABLE "WorkShift" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkShift" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WorkShift" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
ALTER TABLE "WorkShiftReversal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkShiftReversal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WorkShiftReversal" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
