import { Type } from 'class-transformer';
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
} from 'class-validator';
import { MAX_MINOR_UNITS } from '../common/money.js';
export const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ZONED_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i;
export class CreateContributionDto {
  @IsUUID() @Matches(UUID_V7) id!: string;
  @IsUUID() memberId!: string;
  @IsUUID() createdByMemberId!: string;
  @IsUUID() deviceId!: string;
  @IsInt() @Min(1) @Max(MAX_MINOR_UNITS) amountMinor!: number;
  @IsISO8601({ strict: true }) @Matches(ZONED_INSTANT) occurredAt!: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class ContributionListDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(ZONED_INSTANT)
  from?: string;
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(ZONED_INSTANT)
  to?: string;
  @IsOptional() @IsUUID() memberId?: string;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
