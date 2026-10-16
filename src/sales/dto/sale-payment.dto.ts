import { IsIn, IsOptional, Validate } from 'class-validator';
import type {
  ValidationArguments,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ValidatorConstraint } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_MINOR_UNITS } from '../../common/money.js';
import {
  PAYMENT_METHODS,
  isCashPayment,
  type PaymentMethod,
} from '../../common/payment-method.js';

/**
 * `cashReceivedMinor` depends on the payment method:
 * - EFECTIVO (or no method, the legacy shape): required, an integer of cents.
 * - TRANSFERENCIA / TARJETA: the full total is charged, so no cash applies and
 *   the field must be absent (`null` counts as absent; `0` does not — "nothing
 *   received" and "not applicable" are different things).
 */
@ValidatorConstraint({ name: 'cashReceivedMatchesMethod', async: false })
export class CashReceivedMatchesMethod implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    const method = (args.object as { paymentMethod?: PaymentMethod | null })
      .paymentMethod;
    if (!isCashPayment(method)) return value === undefined || value === null;
    return (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= MAX_MINOR_UNITS
    );
  }

  defaultMessage(args: ValidationArguments) {
    const method = (args.object as { paymentMethod?: PaymentMethod | null })
      .paymentMethod;
    return isCashPayment(method)
      ? `cashReceivedMinor must be an integer number of cents between 0 and ${MAX_MINOR_UNITS}`
      : `cashReceivedMinor does not apply to ${String(method)}: the full total is charged, send no cash received`;
  }
}

// Monetary input contract only; the calculation lives in SalesService.
export class SalePaymentDto {
  @ApiProperty({
    required: false,
    enum: PAYMENT_METHODS,
    default: 'EFECTIVO',
    description:
      'How the sale was paid. Absent means EFECTIVO (clients and offline-queued sales that predate this field). ' +
      'TRANSFERENCIA and TARJETA charge the full total.',
  })
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: PaymentMethod | null;

  @ApiProperty({
    required: false,
    minimum: 0,
    description:
      'Required (integer cents) for EFECTIVO. Must be omitted for TRANSFERENCIA and TARJETA, which charge the full total: ' +
      'no cash received and no change apply, and both are stored as null.',
  })
  @Validate(CashReceivedMatchesMethod)
  cashReceivedMinor?: number | null;
}
