-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('socio', 'colaborador');

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "authorized" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "contextId" TEXT NOT NULL DEFAULT 'legacy-unassigned',
ADD COLUMN     "identifier" TEXT;

-- Preserve existing devices without granting them access or inventing physical identities.
UPDATE "Device" SET "identifier" = 'legacy-' || "id"::text WHERE "identifier" IS NULL;
ALTER TABLE "Device" ALTER COLUMN "identifier" SET NOT NULL;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "contextId" TEXT NOT NULL DEFAULT 'legacy-unassigned',
ADD COLUMN     "role" "MemberRole" NOT NULL DEFAULT 'colaborador';

-- CreateTable
CREATE TABLE "Account" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Device_identifier_key" ON "Device"("identifier");
