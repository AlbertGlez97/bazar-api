-- Preserve the day encoded by the previous editor (UTC midnight), independent
-- of the migration session timezone. Hours are deliberately discarded.
ALTER TABLE "CuotaPlaneada"
  ALTER COLUMN "fechaEsperada" TYPE DATE
  USING ("fechaEsperada" AT TIME ZONE 'UTC')::date;
