import { Transform, Type } from 'class-transformer';
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
  ValidateNested,
} from 'class-validator';
import { MAX_MINOR_UNITS } from '../common/money.js';
import { UUID_V7, ZONED_INSTANT } from './contribution.dto.js';

export const EXPENSE_NATURES = [
  'OPERATING_EXPENSE',
  'INVENTORY_PURCHASE',
] as const;
export const EXPENSE_FUNDS_SOURCES = ['BUSINESS', 'PERSONAL'] as const;
export const INVENTORY_CATEGORY = 'inventory';
export const OPERATING_EXPENSE_CATEGORIES = [
  'transport',
  'fuel',
  'food',
  'bazaar_rent',
  'storage',
  'advertising',
  'utilities',
  'packaging',
  'maintenance',
  'operating_payment',
  'other',
] as const;
export const EXPENSE_CATEGORIES = [
  ...OPERATING_EXPENSE_CATEGORIES,
  INVENTORY_CATEGORY,
] as const;
export const EXPENSE_DESCRIPTION_MAX = 280;

export type ExpenseNature = (typeof EXPENSE_NATURES)[number];
export type ExpenseFundsSource = (typeof EXPENSE_FUNDS_SOURCES)[number];

/** INVENTORY_PURCHASE <=> category 'inventory'; enforced in the service and the DB. */
export function isValidNatureCategoryPair(
  nature: string,
  category: string,
): boolean {
  return (nature === 'INVENTORY_PURCHASE') === (category === INVENTORY_CATEGORY);
}

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateExpenseDto {
  @IsUUID() @Matches(UUID_V7) id!: string;
  @IsInt() @Min(1) @Max(MAX_MINOR_UNITS) amountMinor!: number;
  @IsISO8601({ strict: true }) @Matches(ZONED_INSTANT) occurredAt!: string;
  @IsIn(EXPENSE_NATURES) nature!: ExpenseNature;
  @IsIn(EXPENSE_CATEGORIES) category!: string;
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(EXPENSE_DESCRIPTION_MAX)
  description!: string;
  @IsUUID() paidByMemberId!: string;
  @IsIn(EXPENSE_FUNDS_SOURCES) fundsSource!: ExpenseFundsSource;
  @IsUUID() createdByMemberId!: string;
  @IsUUID() deviceId!: string;
}

export class ExpenseListDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(ZONED_INSTANT)
  from?: string;
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(ZONED_INSTANT)
  to?: string;
  @IsOptional() @IsUUID() paidByMemberId?: string;
  @IsOptional() @IsIn(EXPENSE_NATURES) nature?: ExpenseNature;
  @IsOptional() @IsIn(EXPENSE_CATEGORIES) category?: string;
  @IsOptional() @IsString() @MaxLength(500) cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

export class ExpenseSummaryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(ZONED_INSTANT)
  from?: string;
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(ZONED_INSTANT)
  to?: string;
}

export class ReverseExpenseDto {
  @IsUUID() @Matches(UUID_V7) id!: string;
  @IsUUID() createdByMemberId!: string;
  @IsUUID() deviceId!: string;
  @IsISO8601({ strict: true }) @Matches(ZONED_INSTANT) occurredAt!: string;
  @IsString() @MaxLength(1000) @Matches(/\S/) reason!: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateExpenseDto)
  replacement?: CreateExpenseDto;
}
