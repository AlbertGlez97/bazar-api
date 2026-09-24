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
import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({
    required: false,
    description:
      "Optional, for the client's own traceability/logging only. The server always recalculates and charges the current Product.unitPriceMinor; this value is never used for the sale total.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR_UNITS)
  unitPriceMinor?: number;
}

export class CreateSaleDto extends SalePaymentDto {
  // Client-generated (offline-first: the device must be able to name a
  // sale before it ever reaches the server). Also the idempotency key for
  // resends (see SalesService.create): a resend with the same id and an
  // identical payload replays the stored result instead of reprocessing;
  // a resend with the same id and a different payload is a 409 Conflict.
  // The frontend should preferably generate UUIDv7 values so client-owned
  // Sale ids share the backend's time-ordered index characteristics.
  @ApiProperty({
    description:
      'Client-generated sale id (offline-first). Also the idempotency key: resending the same id with an identical payload replays the stored result; a different payload is rejected with 409.',
  })
  @IsUUID()
  id!: string;
  // Must match ContextGuard's header-selected member/device or
  // SalesService.create rejects the sale with 403 — these are carried in
  // the body (rather than only implied by the headers) so the persisted
  // sale is self-describing and, later, comparable across resends.
  @ApiProperty({
    description:
      'Must match the x-member-id selection already authenticated by ContextGuard, or the sale is rejected with 403.',
  })
  @IsUUID()
  memberId!: string;
  @ApiProperty({
    description:
      'Must match the x-device-id selection already authenticated by ContextGuard, or the sale is rejected with 403.',
  })
  @IsUUID()
  deviceId!: string;
  @IsISO8601({ strict: true }) occurredAt!: string;
  // Only 'MXN' is accepted because the money helpers (dinero.js usage in
  // SalesService) are hardcoded to MXN; a multi-currency bazar is not a
  // supported scenario.
  @ApiProperty({
    enum: ['MXN'],
    description: 'Only MXN is supported; the money helpers are MXN-only.',
  })
  @IsIn(['MXN'])
  currency!: string;
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreateSaleItemDto)
  items!: CreateSaleItemDto[];
}
