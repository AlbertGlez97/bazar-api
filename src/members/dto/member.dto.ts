import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_COMMISSION_RATE_BPS } from '../../commissions/dto/commission.dto.js';

/**
 * Both fields optional/independent: a socio may want to rename a
 * colaborador without touching their rate, or vice versa. `commissionRateBps`
 * is rejected by {@link MembersService.patch} (not here — the DTO cannot
 * know the target's role) when the target Member is a `socio`, since a
 * socio is never subject to a sales commission.
 */
export class PatchMemberDto {
  @ValidateIf((o: PatchMemberDto) => o.name !== undefined)
  @IsString()
  @Length(1, 200)
  @Matches(/\S/)
  name?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Individual commission percentage in basis points (1000 = 10.00%). ' +
      'Send null to clear the override and fall back to the global rate. ' +
      'Rejected (400) when the target Member is a socio.',
  })
  @ValidateIf(
    (o: PatchMemberDto) =>
      o.commissionRateBps !== undefined && o.commissionRateBps !== null,
  )
  @IsInt()
  @Min(0)
  @Max(MAX_COMMISSION_RATE_BPS)
  commissionRateBps?: number | null;
}

export class MemberListDto {
  // Defaults to hiding deactivated colaboradores, matching
  // ProductListDto.includeInactive: the everyday seller-selector should
  // never surface someone who can no longer act, but a socio managing the
  // roster opts in explicitly.
  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsIn([true, false])
  includeInactive = false;
}
