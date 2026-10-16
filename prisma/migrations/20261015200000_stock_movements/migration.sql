-- Stock movements: an append-only fact per restock (who added how many pieces,
-- when, and the stock before/after). Additive only: no existing table or row
-- is changed. The movement is written in the same transaction as the atomic
-- `stock = stock + n` update of the product (see ProductsService.restock).

CREATE TYPE "StockMovementType" AS ENUM ('REPOSICION');

CREATE TABLE "StockMovement" (
  "id" UUID NOT NULL,
  "contextId" TEXT NOT NULL,
  "productId" UUID NOT NULL,
  "memberId" UUID NOT NULL,
  "type" "StockMovementType" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "stockBefore" INTEGER NOT NULL,
  "stockAfter" INTEGER NOT NULL,
  "unitCostMinor" INTEGER,
  "note" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockMovement_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "StockMovement_stockBefore_nonnegative" CHECK ("stockBefore" >= 0),
  -- The movement always explains itself: after = before + quantity.
  CONSTRAINT "StockMovement_stock_consistent" CHECK ("stockAfter" = "stockBefore" + "quantity"),
  CONSTRAINT "StockMovement_unitCostMinor_nonnegative" CHECK ("unitCostMinor" IS NULL OR "unitCostMinor" >= 0),
  CONSTRAINT "StockMovement_note_length" CHECK ("note" IS NULL OR length("note") <= 1000)
);

CREATE INDEX "StockMovement_contextId_productId_createdAt_id_idx"
  ON "StockMovement"("contextId", "productId", "createdAt", "id");

ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row Level Security, deny by default (same policy as every tenant table; see
-- 20260924081000_multitenancy_rls): a connection that never sets
-- app.context_id sees and writes nothing.
ALTER TABLE "StockMovement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockMovement" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "StockMovement"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));
