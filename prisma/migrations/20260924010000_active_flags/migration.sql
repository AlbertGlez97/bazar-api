-- BE-10: soft delete. Existing rows default to active=true, so nothing
-- already in the catalog/roster is unintentionally hidden or blocked by
-- this migration.
ALTER TABLE "Product" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Member" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
