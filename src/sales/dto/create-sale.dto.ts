import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_MINOR_UNITS } from '../../common/money.js';
import { SalePaymentDto } from './sale-payment.dto.js';

// Reasonable upper bound for a single sale line; not a business rule, only
// a sanity limit against malformed/abusive payloads.
export const MAX_ITEM_QUANTITY = 100_000;

export class CreateSaleItemDto {
  @IsUUID() productId!: string;
  @IsInt() @Min(1) @Max(MAX_ITEM_QUANTITY) quantity!: number;
  // Client-supplied price kept only for traceability/logging; the server
  // always recalculates the charged price from the current Product record.
  @IsOptional() @IsInt() @Min(0) @Max(MAX_MINOR_UNITS) unitPriceMinor?: number;
}

export class CreateSaleDto extends SalePaymentDto {
  @IsUUID() id!: string;
  @IsUUID() memberId!: string;
  @IsUUID() deviceId!: string;
  @IsISO8601({ strict: true }) occurredAt!: string;
  @IsIn(['MXN']) currency!: string;
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreateSaleItemDto)
  items!: CreateSaleItemDto[];
}
