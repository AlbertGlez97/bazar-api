import { IsString, Length } from 'class-validator';

/** Body of POST /business-registration/verify-email: the token from the emailed link (32 random bytes, base64url). */
export class VerifyEmailDto {
  @IsString() @Length(20, 200) token!: string;
}
