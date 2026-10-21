-- "Is this address already some person's?" across ALL businesses, before a confirmation email is
-- sent. "Member" is row-level secured by business, so the application cannot SEE other
-- businesses' people; the unique index on "Member"."correo", however, ignores row-level security.
-- This function asks that index: it tries to give the address to the caller's own member, answers
-- true when the index refuses (someone has it) and false when it accepts, and in both cases leaves
-- nothing changed (the attempt is rolled back inside the function). It never says WHO has it.
-- Runs as the caller, in the caller's business: it can only touch the caller's own member.
CREATE FUNCTION "member_correo_taken"(p_member_id UUID, p_correo TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 BEGIN
  UPDATE "Member" SET "correo" = lower(p_correo) WHERE "id" = p_member_id AND "correo" IS NULL;
  -- Accepted: undo it by failing this inner block on purpose.
  RAISE EXCEPTION 'address is free' USING ERRCODE = 'P0001';
 EXCEPTION
  WHEN unique_violation THEN RETURN true;
  WHEN raise_exception THEN RETURN false;
 END;
 RETURN false;
END;
$$;
