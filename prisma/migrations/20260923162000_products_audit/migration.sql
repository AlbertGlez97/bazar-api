-- AlterTable
ALTER TABLE "Product" RENAME COLUMN "salePriceMinor" TO "unitPriceMinor";
ALTER TABLE "Product" ADD COLUMN "contextId" TEXT NOT NULL DEFAULT 'legacy-unassigned',
ADD COLUMN "image" TEXT;

-- CreateTable
CREATE TABLE "ProductAudit" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "oldUnitPriceMinor" INTEGER,
    "newUnitPriceMinor" INTEGER NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,

    CONSTRAINT "ProductAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductAudit_productId_changedAt_id_idx" ON "ProductAudit"("productId", "changedAt", "id");

-- CreateIndex
CREATE INDEX "Product_contextId_createdAt_id_idx" ON "Product"("contextId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "ProductAudit" ADD CONSTRAINT "ProductAudit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAudit" ADD CONSTRAINT "ProductAudit_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
