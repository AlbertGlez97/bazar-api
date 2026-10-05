-- Additive only: an expense is a financial fact, not stock, product cost or income.
CREATE TABLE "Expense" (
  "id" UUID NOT NULL PRIMARY KEY,
  "contextId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0),
  "currency" CHAR(3) NOT NULL DEFAULT 'MXN' CHECK ("currency" = 'MXN'),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "nature" TEXT NOT NULL CHECK ("nature" IN ('OPERATING_EXPENSE', 'INVENTORY_PURCHASE')),
  -- The category catalog lives in code (no DB enum); only the inventory pairing is a DB invariant.
  "category" TEXT NOT NULL,
  "description" TEXT NOT NULL CHECK (length("description") BETWEEN 1 AND 280 AND "description" = btrim("description")),
  "paidByMemberId" UUID NOT NULL REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "fundsSource" TEXT NOT NULL CHECK ("fundsSource" IN ('BUSINESS', 'PERSONAL')),
  "createdByMemberId" UUID NOT NULL REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdByAccountId" UUID NOT NULL,
  "deviceId" UUID NOT NULL REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestFingerprint" TEXT NOT NULL,
  "creationResponse" JSONB NOT NULL,
  CONSTRAINT "Expense_nature_category_check" CHECK (("nature" = 'INVENTORY_PURCHASE') = ("category" = 'inventory'))
);
CREATE INDEX "Expense_contextId_occurredAt_id_idx" ON "Expense"("contextId", "occurredAt", "id");
CREATE INDEX "Expense_contextId_paidByMemberId_occurredAt_id_idx" ON "Expense"("contextId", "paidByMemberId", "occurredAt", "id");
ALTER TABLE "Expense" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Expense" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Expense"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));

-- Correction only, never a refund or income.
CREATE TABLE "ExpenseReversal" (
  "id" UUID NOT NULL PRIMARY KEY,
  "contextId" TEXT NOT NULL,
  "expenseId" UUID NOT NULL REFERENCES "Expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "replacementExpenseId" UUID REFERENCES "Expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reason" TEXT NOT NULL CHECK (length(trim("reason")) > 0),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByMemberId" UUID NOT NULL REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdByAccountId" UUID NOT NULL,
  "deviceId" UUID NOT NULL REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "requestFingerprint" TEXT NOT NULL,
  "creationResponse" JSONB NOT NULL,
  CHECK ("replacementExpenseId" IS NULL OR "replacementExpenseId" <> "expenseId")
);
CREATE UNIQUE INDEX "ExpenseReversal_expenseId_key" ON "ExpenseReversal"("expenseId");
CREATE UNIQUE INDEX "ExpenseReversal_replacementExpenseId_key" ON "ExpenseReversal"("replacementExpenseId");
CREATE INDEX "ExpenseReversal_contextId_occurredAt_id_idx" ON "ExpenseReversal"("contextId", "occurredAt", "id");
ALTER TABLE "ExpenseReversal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExpenseReversal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ExpenseReversal"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));
