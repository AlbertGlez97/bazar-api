import { Transform } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MAX_MINOR_UNITS } from '../common/money.js';
import { UUID_V7, ZONED_INSTANT } from './contribution.dto.js';

/** Trims text; a blank optional note becomes null. */
const trimOrNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body of a real payment. The server derives the agreed amount, the balance,
 * the currency, the context, the account and the participant name.
 */
export class CreateDistributionPaymentDto {
  @IsUUID() @Matches(UUID_V7) id!: string;
  @IsUUID() participantMemberId!: string;
  @IsInt() @Min(1) @Max(MAX_MINOR_UNITS) amountMinor!: number;
  @IsISO8601({ strict: true }) @Matches(ZONED_INSTANT) occurredAt!: string;
  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
  @IsUUID() createdByMemberId!: string;
  @IsUUID() deviceId!: string;
}

export class ReverseDistributionPaymentDto {
  @IsUUID() @Matches(UUID_V7) id!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
  @IsISO8601({ strict: true }) @Matches(ZONED_INSTANT) occurredAt!: string;
  @IsUUID() createdByMemberId!: string;
  @IsUUID() deviceId!: string;
}
