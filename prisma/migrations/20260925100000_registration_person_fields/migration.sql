-- The public business registration used two free-text fields: `nombreSocio`
-- (a single name) and `contactoSocio` (an email OR a phone number). They are
-- replaced by real fields: `nombre` + `apellidos` (the socio's name),
-- `correo` (a verified email, required for new requests) and `telefono`
-- (optional).
--
-- Existing rows must survive, so this is expand -> backfill -> contract:
-- the new columns are added nullable, backfilled from the old ones, then
-- tightened to NOT NULL where the model requires it, and only then are the
-- old columns dropped.
ALTER TABLE "BusinessRegistrationRequest"
    ADD COLUMN "nombre" TEXT,
    ADD COLUMN "apellidos" TEXT,
    ADD COLUMN "correo" TEXT,
    ADD COLUMN "telefono" TEXT;

-- Backfill.
--  * nombre: the old single name, untouched (it may already hold a full
--    name; there is no reliable way to split it).
--  * apellidos: '' for legacy rows (the founding Member name is
--    `nombre || ' ' || apellidos`, trimmed, so it stays the old name).
--  * correo: the old contact, trimmed and lower-cased, when it is a plain
--    `local@domain.tld` (the same conservative pattern the application uses
--    to decide whether the credentials can be emailed to the socio); '' when
--    it was a phone number or any other free text. An empty correo makes the
--    approval relay the credentials through the approver, exactly as a
--    non-email contact did before.
--  * telefono: the old contact when it was NOT such an email (so no
--    information is lost), NULL otherwise.
UPDATE "BusinessRegistrationRequest"
SET "nombre" = "nombreSocio",
    "apellidos" = '',
    "correo" = CASE
        WHEN length(btrim("contactoSocio", E' \t\r\n')) <= 254
         AND lower(btrim("contactoSocio", E' \t\r\n')) ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'
        THEN lower(btrim("contactoSocio", E' \t\r\n'))
        ELSE ''
    END,
    "telefono" = CASE
        WHEN length(btrim("contactoSocio", E' \t\r\n')) <= 254
         AND lower(btrim("contactoSocio", E' \t\r\n')) ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'
        THEN NULL
        ELSE "contactoSocio"
    END;

ALTER TABLE "BusinessRegistrationRequest"
    ALTER COLUMN "nombre" SET NOT NULL,
    ALTER COLUMN "apellidos" SET NOT NULL,
    ALTER COLUMN "correo" SET NOT NULL;

ALTER TABLE "BusinessRegistrationRequest"
    DROP COLUMN "nombreSocio",
    DROP COLUMN "contactoSocio";
