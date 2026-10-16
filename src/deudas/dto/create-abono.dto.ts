import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_MINOR_UNITS } from '../../common/money.js';
import { PAYMENT_METHODS, type PaymentMethod } from '../../common/payment-method.js';

export class CreateAbonoDto {
  @IsInt() @Min(1) @Max(MAX_MINOR_UNITS) montoMinor!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  nota?: string;

  @ApiProperty({
    required: false,
    enum: PAYMENT_METHODS,
    default: 'EFECTIVO',
    description:
      'How this abono was paid. Absent means EFECTIVO. It does not change the debt balance, the status or the inventory, and it cannot be edited afterwards.',
  })
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: PaymentMethod | null;
}
