/**
 * How a sale or an abono was paid. Spanish upper case, like
 * `StockMovementType`. Mirrors the Prisma enum `PaymentMethod`; kept as a
 * plain constant so DTOs and helpers do not depend on the generated client.
 *
 * Only the *means* is recorded — never a receipt number or the terminal's
 * reference. The method changes neither stock nor a debt's balance.
 */
export const PAYMENT_METHODS = ['EFECTIVO', 'TRANSFERENCIA', 'TARJETA'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** What an absent method means: clients that predate this field (and the offline queue) only ever took cash. */
export const DEFAULT_PAYMENT_METHOD: PaymentMethod = 'EFECTIVO';

export function resolvePaymentMethod(
  method: PaymentMethod | null | undefined,
): PaymentMethod {
  return method ?? DEFAULT_PAYMENT_METHOD;
}

/** Only EFECTIVO involves cash received and change. */
export function isCashPayment(method: PaymentMethod | null | undefined): boolean {
  return resolvePaymentMethod(method) === 'EFECTIVO';
}
