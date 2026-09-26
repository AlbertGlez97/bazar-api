-- BE-12: team management and device management with one-time activation.
--
-- Everything here is additive and nullable or defaulted, so the seed, the
-- shared business login, every existing device and the current test
-- fixtures keep working without a change:
--  * Account.memberId: the Member a login is bound to. NULL = the shared
--    business login that every account has today. UNIQUE (one login per
--    Member). ON DELETE RESTRICT: a hard delete of a Member must not silently
--    turn its bound login into an unbound one that may select any Member.
--  * Member.createdByMemberId: which Member (a socio) added this one. NULL
--    for the founding socio, the seed and every existing row. ON DELETE SET
--    NULL: it is attribution, not integrity.
--  * Device.status / tokenHash / activatedAt / revokedAt: the activation
--    lifecycle. `status` defaults to 'activo' and `tokenHash` stays NULL, so
--    an existing device is an active LEGACY device that authenticates with
--    x-device-id alone until a socio reissues it. `authorized` and the
--    Device_identifier_key index are left untouched.
--
-- Account is not under row level security (login needs it before any
-- context is known); Member and Device already are, and a new column needs
-- no policy change because the policies are row-level on "contextId".

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('pendiente_activacion', 'activo', 'revocado');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "memberId" UUID;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "createdByMemberId" UUID;

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "status" "DeviceStatus" NOT NULL DEFAULT 'activo',
ADD COLUMN     "tokenHash" TEXT,
ADD COLUMN     "activatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "revokedAt" TIMESTAMPTZ(3);

-- Backfill. Before BE-12 a device was either authorized or not, and the only
-- way to become unauthorized was to be switched off, so the unauthorized ones
-- are the revoked ones. The authorized ones already carry the default
-- 'activo', and no token is ever invented for either.
--
-- "Device" has FORCE ROW LEVEL SECURITY, which also binds the table owner
-- when it is neither a superuser nor BYPASSRLS: with no app.context_id the
-- UPDATE below would match zero rows and change nothing, silently. FORCE is
-- therefore lifted for this statement only and restored right after, inside
-- this same migration transaction.
ALTER TABLE "Device" NO FORCE ROW LEVEL SECURITY;

-- backfill:begin
UPDATE "Device"
SET "status" = 'revocado', "revokedAt" = now()
WHERE "authorized" = false AND "status" = 'activo';
-- backfill:end

ALTER TABLE "Device" FORCE ROW LEVEL SECURITY;

-- CreateIndex
CREATE UNIQUE INDEX "Account_memberId_key" ON "Account"("memberId");

-- CreateIndex
CREATE INDEX "Member_createdByMemberId_idx" ON "Member"("createdByMemberId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_createdByMemberId_fkey" FOREIGN KEY ("createdByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
