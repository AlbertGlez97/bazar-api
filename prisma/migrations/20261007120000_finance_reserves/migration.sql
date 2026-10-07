-- Additive exact-period planning and cancellation facts; no existing fact is rewritten.
CREATE TABLE "FinanceReserve" (
 "id" UUID PRIMARY KEY CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 "contextId" TEXT NOT NULL,
 "name" TEXT NOT NULL CHECK (length(btrim("name")) BETWEEN 1 AND 120),
 "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0),
 "currency" CHAR(3) NOT NULL DEFAULT 'MXN' CHECK ("currency" = 'MXN'),
 "periodFrom" DATE NOT NULL,
 "periodTo" DATE NOT NULL,
 "note" TEXT CHECK (length("note") <= 1000),
 "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdByMemberId" UUID NOT NULL,
 "createdByAccountId" UUID NOT NULL,
 "deviceId" UUID NOT NULL,
 "requestFingerprint" TEXT NOT NULL,
 "creationResponse" JSONB NOT NULL,
 UNIQUE ("id", "contextId"),
 CHECK ("periodFrom" >= DATE '0001-01-01' AND "periodTo" <= DATE '9999-12-31' AND "periodFrom" < "periodTo"),
 FOREIGN KEY ("createdByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("createdByAccountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("deviceId", "contextId") REFERENCES "Device"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "FinanceReserve_contextId_periodFrom_periodTo_id_idx" ON "FinanceReserve"("contextId", "periodFrom", "periodTo", "id");
CREATE INDEX "FinanceReserve_contextId_receivedAt_id_idx" ON "FinanceReserve"("contextId", "receivedAt", "id");
CREATE TABLE "FinanceReserveReversal" (
 "id" UUID PRIMARY KEY CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 "contextId" TEXT NOT NULL,
 "reserveId" UUID NOT NULL UNIQUE,
 "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
 "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdByMemberId" UUID NOT NULL,
 "createdByAccountId" UUID NOT NULL,
 "deviceId" UUID NOT NULL,
 "requestFingerprint" TEXT NOT NULL,
 "creationResponse" JSONB NOT NULL,
 UNIQUE ("reserveId", "contextId"),
 CHECK ("id" <> "reserveId"),
 FOREIGN KEY ("reserveId", "contextId") REFERENCES "FinanceReserve"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("createdByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("createdByAccountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("deviceId", "contextId") REFERENCES "Device"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "FinanceReserveReversal_contextId_occurredAt_id_idx" ON "FinanceReserveReversal"("contextId", "occurredAt", "id");
ALTER TABLE "FinanceReserve" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceReserve" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FinanceReserve" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
ALTER TABLE "FinanceReserveReversal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceReserveReversal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FinanceReserveReversal" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));
