-- AlterTable
ALTER TABLE "Member" ADD COLUMN "commissionRateBps" INTEGER;

-- CreateTable
CREATE TABLE "AppSettings" (
    "contextId" TEXT NOT NULL,
    "defaultCommissionRateBps" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("contextId")
);
