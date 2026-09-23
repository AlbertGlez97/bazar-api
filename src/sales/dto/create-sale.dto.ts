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
  // Client-generated (offline-first: the device must be able to name a
  // sale before it ever reaches the server). Currently only enforced as a
  // unique primary key (BE-02); handling a resend of the same id is BE-06.
  @IsUUID() id!: string;
  // Must match ContextGuard's header-selected member/device or
  // SalesService.create rejects the sale with 403 — these are carried in
  // the body (rather than only implied by the headers) so the persisted
  // sale is self-describing and, later, comparable across resends.
  @IsUUID() memberId!: string;
  @IsUUID() deviceId!: string;
  @IsISO8601({ strict: true }) occurredAt!: string;
  // Only 'MXN' is accepted because the money helpers (dinero.js usage in
  // SalesService) are hardcoded to MXN; a multi-currency bazar is not a
  // supported scenario.
  @IsIn(['MXN']) currency!: string;
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreateSaleItemDto)
  items!: CreateSaleItemDto[];
}
