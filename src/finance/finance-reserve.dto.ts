import { Transform } from 'class-transformer';
import {
  IsIn,
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
  registerDecorator,
} from 'class-validator';
import { MAX_MINOR_UNITS } from '../common/money.js';
import { UUID_V7, ZONED_INSTANT } from './contribution.dto.js';
import { isCalendarDate } from './work-shift.dto.js';
function OrderedPeriod(endProperty: string, optional = false) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'orderedPeriod',
      target: target.constructor,
      propertyName,
      validator: {
        validate(value: unknown, args) {
          const end: unknown = (args!.object as Record<string, unknown>)[
            endProperty
          ];
          return (
            (optional && value === undefined && end === undefined) ||
            (isCalendarDate(value) && isCalendarDate(end) && value < end)
          );
        },
        defaultMessage: () =>
          'Both period dates must be valid YYYY-MM-DD values with from preceding to',
      },
    });
}
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export class CreateFinanceReserveDto {
  @IsUUID() @Matches(UUID_V7) id!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsInt() @Min(1) @Max(MAX_MINOR_UNITS) amountMinor!: number;
  @IsIn(['MXN']) currency = 'MXN';
  @OrderedPeriod('periodTo') periodFrom!: string;
  @IsString() periodTo!: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(1000) note?:
    string | null;
  @IsUUID() createdByMemberId!: string;
  @IsUUID() deviceId!: string;
  @IsISO8601({ strict: true }) @Matches(ZONED_INSTANT) occurredAt!: string;
}
export class FinanceReserveListDto {
  @OrderedPeriod('to', true) from?: string;
  @IsOptional() @IsString() to?: string;
  @IsIn(['active', 'reversed']) status: 'active' | 'reversed' = 'active';
  @IsOptional() @IsString() @MaxLength(1000) cursor?: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
