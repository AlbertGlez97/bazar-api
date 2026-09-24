-- BE-11 part 2: a new business/tenant registers via a public form and
-- waits for manual email approval before any contextId or Member exists
-- for it. This table intentionally has no contextId column and is never
-- covered by Row Level Security or the Prisma tenant-isolation extension
-- (see the model's own doc comment in schema.prisma).
CREATE TYPE "BusinessRegistrationStatus" AS ENUM ('pendiente', 'aprobado', 'rechazado');

CREATE TABLE "BusinessRegistrationRequest" (
    "id" UUID NOT NULL,
    "nombreNegocio" TEXT NOT NULL,
    "nombreSocio" TEXT NOT NULL,
    "contactoSocio" TEXT NOT NULL,
    "status" "BusinessRegistrationStatus" NOT NULL DEFAULT 'pendiente',
    "approvalTokenHash" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdContextId" TEXT,

    CONSTRAINT "BusinessRegistrationRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BusinessRegistrationRequest_approvalTokenHash_idx" ON "BusinessRegistrationRequest"("approvalTokenHash");
