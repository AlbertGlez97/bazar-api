-- BE-15: explicit initial abono, planned installments (CuotaPlaneada — a
-- purely informative payment schedule, never read by any balance
-- calculation), a cost snapshot and a settlement timestamp on Deuda. See
-- odd/tasks/be15-deudas-cuotas-abono-inicial.md (D1-D7) for the full
-- rationale.

-- AlterTable: cost snapshot (same nullable, never-estimated/never-backfilled
-- pattern as SaleItem.unitCostMinor from BE-13) and the settlement instant
-- (D4), set exactly once inside DeudasService.registerAbono's existing
-- transaction, at the moment `status` flips to 'saldada' — never any other
-- way, never backfilled for rows already saldada before this column existed.
ALTER TABLE "Deuda" ADD COLUMN     "unitCostMinor" INTEGER;
ALTER TABLE "Deuda" ADD COLUMN     "saldadaAt" TIMESTAMPTZ(3);

-- CreateTable: CuotaPlaneada (D2), tenant-scoped like every sibling model.
-- Brand new table, no historical rows to backfill.
CREATE TABLE "CuotaPlaneada" (
    "id" UUID NOT NULL,
    "deudaId" UUID NOT NULL,
    "contextId" TEXT NOT NULL DEFAULT 'legacy-unassigned',
    "fechaEsperada" TIMESTAMPTZ(3) NOT NULL,
    "montoEsperadoMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CuotaPlaneada_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CuotaPlaneada"
  ADD CONSTRAINT "CuotaPlaneada_deudaId_fkey" FOREIGN KEY ("deudaId") REFERENCES "Deuda"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "CuotaPlaneada_deudaId_fechaEsperada_idx" ON "CuotaPlaneada"("deudaId", "fechaEsperada");
CREATE INDEX "CuotaPlaneada_contextId_idx" ON "CuotaPlaneada"("contextId");

-- BE-11 pattern mirror (doc/reglas-de-negocio.md's "Multi-tenancy (BE-11)"
-- section): strict deny-by-default RLS, no permissive "OR ... IS NULL"
-- fallback — a connection that never sets app.context_id sees/writes
-- nothing on this table either.
ALTER TABLE "CuotaPlaneada" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CuotaPlaneada" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CuotaPlaneada"
  USING ("contextId" = current_setting('app.context_id', true))
  WITH CHECK ("contextId" = current_setting('app.context_id', true));
