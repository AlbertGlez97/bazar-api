import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// Basis points: 1 bp = 0.01%, so 10000 = 100.00%. Matches
// Member.commissionRateBps/AppSettings.defaultCommissionRateBps — an
// integer, never a Decimal/float, for the same reason the rest of the
// project stores money as integer minor units.
export const MAX_COMMISSION_RATE_BPS = 10_000;

export class SetGlobalCommissionRateDto {
  @ApiProperty({
    description:
      'Default commission percentage in basis points (1000 = 10.00%), applied to every colaborador with no individual override.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_COMMISSION_RATE_BPS)
  rateBps!: number;
}

export class SetMemberCommissionRateDto {
  // Required (not @IsOptional()) so the caller must be explicit: sending
  // `null` clears the override (falls back to the global rate), while
  // omitting the field entirely is rejected as an ambiguous request
  // rather than silently doing nothing.
  @ApiProperty({
    nullable: true,
    description:
      'Individual commission percentage in basis points (1000 = 10.00%). Send null to clear the override and fall back to the global rate.',
  })
  @ValidateIf((o: SetMemberCommissionRateDto) => o.rateBps !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_COMMISSION_RATE_BPS)
  rateBps!: number | null;
}

export class CommissionsQueryDto {
  @ApiProperty({
    required: false,
    description:
      'Restricts the calculation to a single colaborador. Omit to list every colaborador in the period.',
  })
  @IsOptional()
  @IsUUID()
  memberId?: string;

  // `from`/`to` must be provided together (or not at all — see
  // CommissionsService.calculate); when both are omitted, the current
  // domingo-sábado business week is resolved automatically, per the
  // approved "semana" auto-resolution behavior.
  @ApiProperty({
    required: false,
    description:
      'Range start (date-only or full ISO-8601 instant). Omit both from/to for the current Sunday-Saturday week.',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiProperty({ required: false, description: 'Range end (inclusive).' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
