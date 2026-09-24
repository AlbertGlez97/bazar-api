-- BE-11 (part 1 of 2): add a direct contextId column to every model that
-- was, until now, only tenant-scoped indirectly through a relation (e.g.
-- Sale via Member, ProductAudit via Product). A direct column is required
-- by both the new Prisma tenant-isolation extension (which filters/injects
-- on a model's own column, not a join) and the Postgres Row Level Security
-- policies added in the next migration.
--
-- Every one of these tables previously belonged to a single, implicit
-- context (this system was single-tenant through BE-10), so backfilling
-- via the existing relation is exact, not a guess: a Sale's contextId is
-- always its Member's contextId, an Incidencia's is always its Sale's, and
-- so on. `DEFAULT 'legacy-unassigned'` only matters for any row that
-- somehow has no resolvable relation (should not happen in practice, but
-- keeps the column NOT NULL-safe without inventing data).
ALTER TABLE "ProductAudit" ADD COLUMN     "contextId" TEXT NOT NULL DEFAULT 'legacy-unassigned';
ALTER TABLE "Sale" ADD COLUMN     "contextId" TEXT NOT NULL DEFAULT 'legacy-unassigned';
ALTER TABLE "SaleItem" ADD COLUMN     "contextId" TEXT NOT NULL DEFAULT 'legacy-unassigned';
ALTER TABLE "Incidencia" ADD COLUMN     "contextId" TEXT NOT NULL DEFAULT 'legacy-unassigned';
ALTER TABLE "Deuda" ADD COLUMN     "contextId" TEXT NOT NULL DEFAULT 'legacy-unassigned';
ALTER TABLE "Abono" ADD COLUMN     "contextId" TEXT NOT NULL DEFAULT 'legacy-unassigned';

-- Backfill from the existing, already-correct relation instead of leaving
-- historical rows stuck on the placeholder default.
UPDATE "ProductAudit" pa SET "contextId" = p."contextId" FROM "Product" p WHERE p.id = pa."productId";
UPDATE "Sale" s SET "contextId" = m."contextId" FROM "Member" m WHERE m.id = s."memberId";
UPDATE "SaleItem" si SET "contextId" = s."contextId" FROM "Sale" s WHERE s.id = si."saleId";
UPDATE "Incidencia" i SET "contextId" = s."contextId" FROM "Sale" s WHERE s.id = i."saleId";
UPDATE "Deuda" d SET "contextId" = m."contextId" FROM "Member" m WHERE m.id = d."createdByMemberId";
UPDATE "Abono" a SET "contextId" = d."contextId" FROM "Deuda" d WHERE d.id = a."deudaId";

-- CreateIndex
CREATE INDEX "ProductAudit_contextId_idx" ON "ProductAudit"("contextId");
CREATE INDEX "Sale_contextId_idx" ON "Sale"("contextId");
CREATE INDEX "SaleItem_contextId_idx" ON "SaleItem"("contextId");
CREATE INDEX "Incidencia_contextId_idx" ON "Incidencia"("contextId");
CREATE INDEX "Deuda_contextId_idx" ON "Deuda"("contextId");
CREATE INDEX "Abono_contextId_idx" ON "Abono"("contextId");
