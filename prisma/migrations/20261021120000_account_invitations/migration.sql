-- Additive: single-use invitations that let an existing socio create their own login,
-- and the snapshot of how an approving account was created (kept inside the approval).

CREATE TABLE "AccountInvitation" (
 "id" UUID PRIMARY KEY CHECK ("id"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 "contextId" TEXT NOT NULL,
 "memberId" UUID NOT NULL,
 "email" TEXT NOT NULL CHECK (length("email") BETWEEN 3 AND 100 AND "email" = lower(btrim("email"))),
 -- Only the SHA-256 of the token is stored; the token itself exists only in the emailed link.
 "tokenHash" CHAR(64) NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
 "invitedByMemberId" UUID NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL,
 "usedAt" TIMESTAMPTZ(3),
 "supersededAt" TIMESTAMPTZ(3),
 "accountId" UUID,
 CHECK ("expiresAt" > "createdAt"),
 CHECK (("usedAt" IS NULL) = ("accountId" IS NULL)),
 FOREIGN KEY ("memberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("invitedByMemberId", "contextId") REFERENCES "Member"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("accountId", "contextId") REFERENCES "Account"("id", "contextId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "AccountInvitation_contextId_memberId_createdAt_idx" ON "AccountInvitation"("contextId", "memberId", "createdAt");
CREATE UNIQUE INDEX "AccountInvitation_accountId_key" ON "AccountInvitation"("accountId") WHERE "accountId" IS NOT NULL;

-- Tenant isolation for the application role. ENABLE without FORCE on purpose: the two
-- SECURITY DEFINER functions below run as the table owner and must read a row by token
-- hash BEFORE its tenant is known (the public page has no session). The runtime role is
-- not the owner, so the policy binds it exactly like every other tenant table.
ALTER TABLE "AccountInvitation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AccountInvitation" USING ("contextId" = current_setting('app.context_id', true)) WITH CHECK ("contextId" = current_setting('app.context_id', true));

-- How the approving account was created, written once with the approval (never recomputed).
ALTER TABLE "FinanceRuleApproval" ADD COLUMN "accountOrigin" JSONB CHECK ("accountOrigin" IS NULL OR jsonb_typeof("accountOrigin") = 'object');

-- Public page, step 1: read-only. Returns the minimum the page needs and nothing else,
-- and only for a live invitation (not used, not replaced, not expired).
-- Member is FORCE row-level secured, so the function sets the invitation's own tenant for
-- the duration of the read and puts the caller's previous value back before returning.
CREATE FUNCTION "account_invitation_lookup"(p_token_hash TEXT)
RETURNS TABLE ("memberName" TEXT, "email" TEXT, "expiresAt" TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE inv RECORD; prev TEXT; found_name TEXT;
BEGIN
 SELECT i."contextId", i."memberId", i."email", i."expiresAt" INTO inv
 FROM "AccountInvitation" i
 WHERE i."tokenHash" = p_token_hash
   AND i."usedAt" IS NULL AND i."supersededAt" IS NULL AND i."expiresAt" > now();
 IF NOT FOUND THEN RETURN; END IF;
 prev := current_setting('app.context_id', true);
 PERFORM set_config('app.context_id', inv."contextId", true);
 SELECT m."name" INTO found_name FROM "Member" m
 WHERE m."id" = inv."memberId" AND m."contextId" = inv."contextId" AND m."active" AND m."role" = 'socio';
 PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
 IF found_name IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT found_name, inv."email", inv."expiresAt";
END;
$$;

-- Public page, step 2: consumes the invitation and creates the login in ONE statement
-- block. FOR UPDATE makes a double submit end with exactly one winner. Returns the email
-- on success and no row for any failure, so callers cannot tell the reasons apart.
CREATE FUNCTION "account_invitation_accept"(p_token_hash TEXT, p_account_id UUID, p_password_hash TEXT)
RETURNS TABLE ("email" TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE inv RECORD; prev TEXT; member_ok BOOLEAN;
BEGIN
 SELECT i."id", i."contextId", i."memberId", i."email" INTO inv
 FROM "AccountInvitation" i
 WHERE i."tokenHash" = p_token_hash
   AND i."usedAt" IS NULL AND i."supersededAt" IS NULL AND i."expiresAt" > now()
 FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 prev := current_setting('app.context_id', true);
 PERFORM set_config('app.context_id', inv."contextId", true);
 SELECT EXISTS (SELECT 1 FROM "Member" m WHERE m."id" = inv."memberId" AND m."contextId" = inv."contextId" AND m."active" AND m."role" = 'socio') INTO member_ok;
 PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
 IF NOT member_ok THEN RETURN; END IF;
 IF EXISTS (SELECT 1 FROM "Account" a WHERE a."memberId" = inv."memberId") THEN RETURN; END IF;
 IF EXISTS (SELECT 1 FROM "Account" a WHERE a."username" = inv."email") THEN RETURN; END IF;
 INSERT INTO "Account" ("id", "username", "passwordHash", "contextId", "active", "memberId")
 VALUES (p_account_id, inv."email", p_password_hash, inv."contextId", true, inv."memberId");
 UPDATE "AccountInvitation" SET "usedAt" = now(), "accountId" = p_account_id WHERE "id" = inv."id";
 RETURN QUERY SELECT inv."email";
END;
$$;
