BEGIN;

-- Fail closed instead of losing an unexpected pre-existing storage reference.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Product" WHERE "image" IS NOT NULL
    AND "image" !~ '^(/uploads/products/)?[0-9a-f-]{36}\.png$') THEN
    RAISE EXCEPTION 'Unexpected product image reference; review before migrating';
  END IF;
END $$;

ALTER TABLE "Product" RENAME COLUMN "image" TO "imagePath";
UPDATE "Product" SET "imagePath" = regexp_replace("imagePath", '^/uploads/products/', '')
WHERE "imagePath" LIKE '/uploads/products/%';

COMMIT;
