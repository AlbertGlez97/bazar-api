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
import { UUID_V7, ZONED_INSTANT } from './contribution.dto.js';
import { FinanceDistributionSimulationDto } from './finance-distribution.dto.js';
import { isCalendarDate } from './work-shift.dto.js';

export const SIMULATION_FINGERPRINT_FORMAT = /^sim1:[0-9a-f]{64}$/;
export const AGREEMENT_FOLIO_FORMAT = /^AC-[0-9]{4}-[0-9]{5,}$/;
export const AGREEMENT_STATUSES = ['active', 'voided'] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Optional exact-period filter: both dates or none, from preceding to.
function OptionalOrderedPeriod(endProperty: string) {
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
            (value === undefined && end === undefined) ||
            (isCalendarDate(value) && isCalendarDate(end) && value < end)
          );
        },
        defaultMessage: () =>
          'Both period dates must be valid YYYY-MM-DD values with from preceding to',
      },
    });
}

/**
 * Creation body. The simulation inputs (period, amount, shares, basis) are the
 * same validated fields of the simulator; the server recomputes everything from
 * them and never accepts client-supplied pools, members or totals.
 */
export class CreateDistributionAgreementDto extends FinanceDistributionSimulationDto {
  @IsUUID() @Matches(UUID_V7) id!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) title!: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(1000) note?:
    string | null;
  @Matches(SIMULATION_FINGERPRINT_FORMAT) simulationFingerprint!: string;
  @IsOptional() @IsUUID() @Matches(UUID_V7) replacesAgreementId?: string | null;
  @IsISO8601({ strict: true }) @Matches(ZONED_INSTANT) occurredAt!: string;
  @IsUUID() createdByMemberId!: string;
  @IsUUID() deviceId!: string;
}

export class DistributionAgreementListDto {
  @OptionalOrderedPeriod('to') from?: string;
  @IsOptional() @IsString() to?: string;
  @IsIn(AGREEMENT_STATUSES) status: AgreementStatus = 'active';
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsOptional()
  @Matches(AGREEMENT_FOLIO_FORMAT)
  folio?: string;
  @IsOptional() @IsString() @MaxLength(1000) cursor?: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class ReverseDistributionAgreementDto {
  @IsUUID() @Matches(UUID_V7) id!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
  @IsISO8601({ strict: true }) @Matches(ZONED_INSTANT) occurredAt!: string;
  @IsUUID() createdByMemberId!: string;
  @IsUUID() deviceId!: string;
}
