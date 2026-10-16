-- Business registration v2: the correo is verified with an emailed link before the request
-- reaches the approver, plus the new questions of the form.
-- Additive: no existing row changes meaning. Every new column is NULL (or 0) on the rows that
-- already exist, and their status values are untouched.

-- A request whose correo is not confirmed yet. The approver is not told about it.
ALTER TYPE "BusinessRegistrationStatus" ADD VALUE 'pendiente_correo' BEFORE 'pendiente';

CREATE TYPE "BusinessType" AS ENUM (
  'bazar_o_tianguis', 'abarrotes', 'ropa_y_accesorios', 'comida_y_bebidas',
  'plantas_y_jardineria', 'artesanias', 'servicios', 'otro'
);

ALTER TABLE "BusinessRegistrationRequest"
  ADD COLUMN "tipoNegocio" "BusinessType",
  ADD COLUMN "queVende" TEXT,
  ADD COLUMN "dondeVende" TEXT,
  ADD COLUMN "recomendadoPor" TEXT,
  ADD COLUMN "legalVersion" TEXT,
  ADD COLUMN "legalAcceptedAt" TIMESTAMPTZ(3),
  ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ(3),
  ADD COLUMN "emailTokenHash" TEXT,
  ADD COLUMN "emailTokenExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "verificationEmailsSent" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastVerificationEmailAt" TIMESTAMPTZ(3);

CREATE INDEX "BusinessRegistrationRequest_emailTokenHash_idx"
  ON "BusinessRegistrationRequest"("emailTokenHash");
CREATE INDEX "BusinessRegistrationRequest_status_createdAt_idx"
  ON "BusinessRegistrationRequest"("status", "createdAt");

-- At most ONE live request per correo among registration-v2 rows (two simultaneous
-- submissions cannot create duplicates; a rejected request frees the correo). Rows that
-- existed before this migration have no "legalVersion", so they are outside the index: it
-- can never fail on old data.
CREATE UNIQUE INDEX "BusinessRegistrationRequest_live_correo_key"
  ON "BusinessRegistrationRequest"("correo")
  WHERE "status" <> 'rechazado' AND "correo" <> '' AND "legalVersion" IS NOT NULL;
