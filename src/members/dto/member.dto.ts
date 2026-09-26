import {
  IsEmail,
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

/** Trims surrounding whitespace so a value made only of spaces counts as blank. */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const MEMBER_ROLES = ['socio', 'colaborador'] as const;
export type MemberRoleName = (typeof MEMBER_ROLES)[number];

/**
 * A socio adds a person to its own business (`POST /members`, BE-12). The
 * person gets their own login, created together with the Member and emailed
 * to `correo`, which is used ONLY to send those credentials (it is not
 * stored). `nombre`, `apellidos` and `correo` are trimmed before they are
 * validated. The id, the context, the username and the password are always
 * chosen by the server: any of them in the body is rejected (400), like every
 * other unknown field.
 *
 * `commissionRateBps` only applies to a colaborador; {@link MembersService.create}
 * rejects it (400) for a socio, since the DTO cannot see the role in the
 * property validators. Omit it (or send null) to use the global rate.
 */
export class CreateMemberDto {
  @Transform(trim) @IsString() @Length(1, 100) @Matches(/\S/) nombre!: string;
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  @Matches(/\S/)
  apellidos!: string;
  // `@IsEmail()` already rejects an address over 254 characters and anything
  // that is not a single plain address ("Ana <a@b.c>", "a@b.c, d@e.f").
  @Transform(trim) @IsEmail() correo!: string;
  @IsIn(MEMBER_ROLES) role!: MemberRoleName;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Individual commission percentage in basis points (1000 = 10.00%). ' +
      'Only for a colaborador; omit it or send null to use the global rate. ' +
      'Rejected (400) when role is socio.',
  })
  @ValidateIf(
    (o: CreateMemberDto) =>
      o.commissionRateBps !== undefined && o.commissionRateBps !== null,
  )
  @IsInt()
  @Min(0)
  @Max(MAX_COMMISSION_RATE_BPS)
  commissionRateBps?: number | null;
}

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
  // ProductListDto.includeInactive: only takes effect when the caller's
  // x-member-id header resolves to an active socio (see
  // MembersService.list) — silently ignored otherwise, not rejected.
  @ApiProperty({
    required: false,
    default: false,
    description:
      'Also include deactivated colaboradores. Only takes effect when ' +
      'the x-member-id header identifies an active socio; ignored ' +
      'otherwise.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsIn([true, false])
  includeInactive = false;
}
