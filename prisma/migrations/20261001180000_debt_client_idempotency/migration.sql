-- Additive only: historical rows have no replay authority.
ALTER TABLE "Deuda"
  ADD COLUMN "requestFingerprint" TEXT,
  ADD COLUMN "creationResponse" JSONB;
