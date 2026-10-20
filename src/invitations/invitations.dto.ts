import { IsString, Length, Matches } from 'class-validator';
import {
  MAX_PASSWORD_LENGTH,
  MIN_NEW_PASSWORD_LENGTH,
} from '../auth/dto/change-password.dto.js';
import { INVITATION_TOKEN_PATTERN } from './invitation-token.js';

/** Body of `POST /members/:id/invitation`. The address itself is checked by the service. */
export class InviteMemberDto {
  @IsString()
  @Length(1, 254)
  email!: string;
}

/** Body of `POST /invitations/inspect`. */
export class InspectInvitationDto {
  @IsString()
  @Matches(INVITATION_TOKEN_PATTERN)
  token!: string;
}

/**
 * Body of `POST /invitations/accept`. The password follows the same policy as
 * `POST /auth/change-password` and is used exactly as sent (never trimmed).
 */
export class AcceptInvitationDto extends InspectInvitationDto {
  @IsString()
  @Length(MIN_NEW_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH)
  password!: string;
}
