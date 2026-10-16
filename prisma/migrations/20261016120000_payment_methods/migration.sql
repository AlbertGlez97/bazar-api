-- Payment methods for sales and abonos (EFECTIVO / TRANSFERENCIA / TARJETA).
-- Additive: no existing row changes meaning. Every existing Sale and Abono was
-- taken in cash, so they all become EFECTIVO through the column default.

CREATE TYPE "PaymentMethod" AS ENUM ('EFECTIVO', 'TRANSFERENCIA', 'TARJETA');

ALTER TABLE "Sale"  ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'EFECTIVO';
ALTER TABLE "Abono" ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'EFECTIVO';

-- A sale paid by TRANSFERENCIA/TARJETA charges the full total: there is no cash
-- received, so the column must be able to hold NULL ("not applicable", never 0).
-- Loosening a NOT NULL does not touch any existing value.
ALTER TABLE "Sale" ALTER COLUMN "cashReceivedMinor" DROP NOT NULL;

-- Cash and change only exist for EFECTIVO. Existing rows are all EFECTIVO, so
-- the constraint is satisfied by every one of them.
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_noncash_has_no_cash"
  CHECK ("paymentMethod" = 'EFECTIVO' OR ("cashReceivedMinor" IS NULL AND "changeMinor" IS NULL));
