-- Additive: remember that an invitation was created from the business's shared login (which
-- cannot prove who is using it), so the approving account's origin can say so later.
ALTER TABLE "AccountInvitation" ADD COLUMN "invitedViaSharedLogin" BOOLEAN NOT NULL DEFAULT false;
