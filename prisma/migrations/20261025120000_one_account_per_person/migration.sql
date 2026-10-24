-- One account per person. Every login must belong to exactly one Member, so the old "shared
-- business login" (Account.memberId IS NULL) is tied to the business's founding socio: the
-- oldest Member with role 'socio' (ties broken by id). Additive: no column, table or row is
-- removed; only Account.memberId is filled where it was NULL. The column stays nullable on
-- purpose: an account that cannot be tied unambiguously stays unbound (and is refused by the
-- API with "Tu cuenta no tiene una persona asignada") instead of being tied to a guess.
--
-- Account.memberId is UNIQUE, so one person can hold only one account. The cases that cannot
-- be tied are left alone and counted in the notice at the end:
--   - the business has no socio;
--   - the founder already has another account;
--   - the business has several unbound accounts (only the oldest is tied).

-- "Member" has FORCE ROW LEVEL SECURITY, which also binds the table owner: with no
-- app.context_id the founder lookup would see zero rows. FORCE is lifted for these statements
-- only and restored right after, inside this same migration transaction (same technique as
-- the rules-approval backfill).
ALTER TABLE "Member" NO FORCE ROW LEVEL SECURITY;

-- backfill:begin
CREATE TEMP TABLE "_one_account_plan" ON COMMIT DROP AS
SELECT DISTINCT ON (a."contextId")
  a."id" AS "accountId",
  a."contextId" AS "contextId",
  f."id" AS "founderId"
FROM "Account" a
JOIN LATERAL (
  SELECT m."id"
  FROM "Member" m
  WHERE m."contextId" = a."contextId" AND m."role" = 'socio'
  ORDER BY m."createdAt", m."id"
  LIMIT 1
) f ON true
WHERE a."memberId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Account" o WHERE o."memberId" = f."id")
ORDER BY a."contextId", a."createdAt", a."id";

UPDATE "Account" a
SET "memberId" = p."founderId"
FROM "_one_account_plan" p
WHERE a."id" = p."accountId" AND a."memberId" IS NULL;
-- backfill:end

DO $$
DECLARE
  v_tied INTEGER;
  v_left INTEGER;
BEGIN
  SELECT count(*) INTO v_tied FROM "_one_account_plan";
  SELECT count(*) INTO v_left FROM "Account" WHERE "memberId" IS NULL;
  RAISE NOTICE 'one_account_per_person: % account(s) tied to their business founding socio (% business(es)); % account(s) left unbound (no socio, founder already has an account, or several unbound accounts in the business).',
    v_tied, v_tied, v_left;
END
$$;

ALTER TABLE "Member" FORCE ROW LEVEL SECURITY;
