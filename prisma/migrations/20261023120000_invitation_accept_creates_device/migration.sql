-- Accepting an invitation now also registers the device the person is using, in the SAME block
-- as the account and the spent link: no half-done state, and exactly one winner when two
-- submissions race (the invitation row stays locked FOR UPDATE).
--
-- The function's result type changes, so it is replaced, not altered. Only the SHA-256 of the
-- device token reaches the database; the caller keeps the plain token and shows it once.
DROP FUNCTION "account_invitation_accept"(TEXT, UUID, TEXT);

CREATE FUNCTION "account_invitation_accept"(
  p_token_hash TEXT, p_account_id UUID, p_password_hash TEXT,
  p_device_id UUID, p_device_identifier TEXT, p_device_token_hash TEXT)
RETURNS TABLE ("email" TEXT, "deviceName" TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE inv RECORD; prev TEXT; member_name TEXT; device_name TEXT;
BEGIN
 SELECT i."id", i."contextId", i."memberId", i."email" INTO inv
 FROM "AccountInvitation" i
 WHERE i."tokenHash" = p_token_hash
   AND i."usedAt" IS NULL AND i."supersededAt" IS NULL AND i."expiresAt" > now()
 FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 -- Member and Device are FORCE row-level secured: work inside the invitation's own tenant and
 -- put the caller's previous value back before returning.
 prev := current_setting('app.context_id', true);
 PERFORM set_config('app.context_id', inv."contextId", true);
 SELECT m."name" INTO member_name FROM "Member" m
  WHERE m."id" = inv."memberId" AND m."contextId" = inv."contextId" AND m."active" AND m."role" = 'socio';
 IF member_name IS NULL
    OR EXISTS (SELECT 1 FROM "Account" a WHERE a."memberId" = inv."memberId")
    OR EXISTS (SELECT 1 FROM "Account" a WHERE a."username" = inv."email") THEN
  PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
  RETURN;
 END IF;
 device_name := left('Dispositivo de ' || member_name, 100);
 INSERT INTO "Account" ("id", "username", "passwordHash", "contextId", "active", "memberId")
 VALUES (p_account_id, inv."email", p_password_hash, inv."contextId", true, inv."memberId");
 INSERT INTO "Device" ("id", "name", "identifier", "contextId", "authorized", "status", "tokenHash", "activatedAt")
 VALUES (p_device_id, device_name, p_device_identifier, inv."contextId", true, 'activo', p_device_token_hash, now());
 UPDATE "AccountInvitation" SET "usedAt" = now(), "accountId" = p_account_id WHERE "id" = inv."id";
 PERFORM set_config('app.context_id', COALESCE(prev, ''), true);
 RETURN QUERY SELECT inv."email", device_name;
END;
$$;
