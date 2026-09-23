-- CreateEnum
CREATE TYPE "DeudaType" AS ENUM ('fiado', 'apartado');
CREATE TYPE "DeudaStatus" AS ENUM ('pendiente', 'saldada');

-- CreateTable
CREATE TABLE "Deudor" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT,
    "notas" TEXT,
    "contextId" TEXT NOT NULL DEFAULT 'legacy-unassigned',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deudor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deuda" (
    "id" UUID NOT NULL,
    "type" "DeudaType" NOT NULL,
    "deudorId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "status" "DeudaStatus" NOT NULL DEFAULT 'pendiente',
    "createdByMemberId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deuda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Abono" (
    "id" UUID NOT NULL,
    "deudaId" UUID NOT NULL,
    "montoMinor" INTEGER NOT NULL,
    "receivedByMemberId" UUID NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nota" TEXT,

    CONSTRAINT "Abono_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Deuda"
  ADD CONSTRAINT "Deuda_deudorId_fkey" FOREIGN KEY ("deudorId") REFERENCES "Deudor"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Deuda_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Deuda_createdByMemberId_fkey" FOREIGN KEY ("createdByMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Abono"
  ADD CONSTRAINT "Abono_deudaId_fkey" FOREIGN KEY ("deudaId") REFERENCES "Deuda"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Abono_receivedByMemberId_fkey" FOREIGN KEY ("receivedByMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Deudor_contextId_nombre_idx" ON "Deudor"("contextId", "nombre");
CREATE INDEX "Deuda_status_createdAt_id_idx" ON "Deuda"("status", "createdAt", "id");
CREATE INDEX "Abono_deudaId_receivedAt_id_idx" ON "Abono"("deudaId", "receivedAt", "id");
