-- CreateEnum
CREATE TYPE "IncidenciaType" AS ENUM ('conflicto_stock', 'incidencia_fecha');
CREATE TYPE "IncidenciaResolutionStatus" AS ENUM ('pendiente', 'resuelta');

-- CreateTable
CREATE TABLE "Incidencia" (
    "id" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "type" "IncidenciaType" NOT NULL,
    "reason" TEXT NOT NULL,
    "detectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolutionStatus" "IncidenciaResolutionStatus" NOT NULL DEFAULT 'pendiente',
    "resolvedByMemberId" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolutionNotes" TEXT,

    CONSTRAINT "Incidencia_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Incidencia"
  ADD CONSTRAINT "Incidencia_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Incidencia_resolvedByMemberId_fkey" FOREIGN KEY ("resolvedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Incidencia_resolutionStatus_detectedAt_id_idx" ON "Incidencia"("resolutionStatus", "detectedAt", "id");
