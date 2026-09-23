-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('completada', 'rechazada_por_conflicto');

-- AlterTable
-- Existing BE-05 sales are all "completada" (the enum default), and all
-- already have a computed totalMinor/changeMinor, so no backfill is
-- needed beyond relaxing NOT NULL for future conflict-rejected sales.
ALTER TABLE "Sale"
  ADD COLUMN "status" "SaleStatus" NOT NULL DEFAULT 'completada',
  ADD COLUMN "conflictReason" TEXT,
  ADD COLUMN "conflictDetectedAt" TIMESTAMPTZ(3),
  ALTER COLUMN "totalMinor" DROP NOT NULL,
  ALTER COLUMN "changeMinor" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Sale_status_receivedAt_id_idx" ON "Sale"("status", "receivedAt", "id");
