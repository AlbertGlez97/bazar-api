import { IsString, Length, Matches } from 'class-validator';
import { SINGLE_USE_TOKEN_PATTERN } from '../common/single-use-token.js';

/** Body of `PUT /members/me/email`. The address itself is checked by the service. */
export class SetMemberEmailDto {
  @IsString()
  @Length(1, 254)
  correo!: string;
}

/** Body of `POST /member-emails/inspect` and `/confirm`: the token from the emailed link. */
export class ConfirmMemberEmailDto {
  @IsString()
  @Matches(SINGLE_USE_TOKEN_PATTERN)
  token!: string;
}
