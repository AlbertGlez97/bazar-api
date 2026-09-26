import {
  IsString,
  Length,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/** The new password must be at least this long. */
export const MIN_NEW_PASSWORD_LENGTH = 10;
/**
 * Upper bound for both passwords. Argon2 cost grows with the input, so an
 * unbounded password would be a cheap way to burn CPU on every request.
 */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * The decorated string must not equal the string in `property`. Skipped when
 * either side is not a string (the type validators report that on their own).
 * The message names the fields, never their values.
 */
function DiffersFrom(property: string, options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'differsFrom',
      target: target.constructor,
      propertyName,
      constraints: [property],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const [related] = args.constraints as [string];
          const other = (args.object as Record<string, unknown>)[related];
          return (
            typeof value !== 'string' ||
            typeof other !== 'string' ||
            value !== other
          );
        },
        defaultMessage(args: ValidationArguments) {
          const [related] = args.constraints as [string];
          return `${args.property} must differ from ${related}`;
        },
      },
    });
}

/**
 * Body of `POST /auth/change-password`. Passwords are used exactly as sent:
 * they are never trimmed or otherwise altered.
 */
export class ChangePasswordDto {
  @IsString() @Length(1, MAX_PASSWORD_LENGTH) currentPassword!: string;

  @IsString()
  @Length(MIN_NEW_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH)
  @DiffersFrom('currentPassword')
  newPassword!: string;
}
