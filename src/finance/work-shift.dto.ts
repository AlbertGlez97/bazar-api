import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  IsISO8601,
  ValidateNested,
  registerDecorator,
} from 'class-validator';
import { UUID_V7, ZONED_INSTANT } from './contribution.dto.js';
export function isCalendarDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) ||
    value.startsWith('0000')
  )
    return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
function CalendarDate() {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'calendarDate',
      target: target.constructor,
      propertyName,
      validator: {
        validate: isCalendarDate,
        defaultMessage: () => 'Date must be a valid YYYY-MM-DD calendar date',
      },
    });
}
export class CreateWorkShiftDto {
  @IsUUID() @Matches(UUID_V7) id!: string;
  @IsUUID() memberId!: string;
  @CalendarDate() workDate!: string;
  @IsOptional() @IsInt() @Min(1) @Max(2147483647) minutes?: number | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
  @IsUUID() createdByMemberId!: string;
  @IsUUID() deviceId!: string;
}
export class WorkShiftSummaryDto {
  @IsOptional() @CalendarDate() from?: string;
  @IsOptional() @CalendarDate() to?: string;
  @IsOptional() @IsUUID() memberId?: string;
  @IsOptional() @IsIn(['known', 'unknown']) duration?: 'known' | 'unknown';
}
export class WorkShiftListDto extends WorkShiftSummaryDto {
  @IsOptional() @IsIn(['active', 'reversed']) status?: 'active' | 'reversed';
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class ReverseWorkShiftDto {
  @IsUUID() @Matches(UUID_V7) id!: string;
  @IsUUID() createdByMemberId!: string;
  @IsUUID() deviceId!: string;
  @IsISO8601({ strict: true }) @Matches(ZONED_INSTANT) occurredAt!: string;
  @IsString() @MaxLength(1000) @Matches(/\S/) reason!: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateWorkShiftDto)
  replacement?: CreateWorkShiftDto;
}
