-- Optional descriptors of a product: brand, presentation (size, measure or
-- capacity) and a short description. Additive: three nullable columns, no
-- default and no backfill, so every existing product keeps all its values and
-- simply has NULL here. Length limits (40 / 40 / 200) live in the DTOs.

ALTER TABLE "Product" ADD COLUMN "brand" TEXT;
ALTER TABLE "Product" ADD COLUMN "presentation" TEXT;
ALTER TABLE "Product" ADD COLUMN "description" TEXT;
