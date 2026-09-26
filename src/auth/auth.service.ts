import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../common/password.js';
import { PrismaService } from '../database/prisma.service.js';
import { JWT_EXPIRES_IN_SECONDS } from './jwt.constants.js';

@Injectable()
export class AuthService {
  // Argon2id hash of a random value, computed once at startup and reused on
  // every login for an unknown username. Without this, verifying against a
  // fresh dummy hash per-request would still leak via not doing any hashing
  // at all when the username doesn't exist, letting an attacker distinguish
  // "unknown user" from "wrong password" through response timing.
  private readonly dummyHash = hashPassword(randomBytes(32).toString('hex'));
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  /**
   * Authenticates a username/password pair and issues a short-lived JWT
   * naming the {@link Account} (`sub`).
   *
   * Always runs an Argon2 verification, even for an unknown username
   * (against {@link dummyHash}) or a deactivated account, so the response
   * time and error do not reveal whether the account exists — both cases
   * throw the identical `UnauthorizedException('Invalid credentials')`.
   *
   * The token only carries the account id; it does not select a Member or
   * Device (see {@link ContextGuard}), and it is not itself scoped to the
   * account's `contextId` — every guard re-reads the account's current
   * context so a later change is honored without re-issuing tokens.
   *
   * @throws UnauthorizedException when the username is unknown, the account
   * is inactive, or the password does not match.
   */
  async login(username: string, password: string) {
    const account = await this.prisma.account.findUnique({
      where: { username },
    });
    const matches = await verifyPassword(
      account?.passwordHash ?? (await this.dummyHash),
      password,
    );
    if (!account?.active || !matches)
      throw new UnauthorizedException('Invalid credentials');
    return {
      accessToken: await this.jwt.signAsync({ sub: account.id }),
      tokenType: 'Bearer',
      // Mirrors JwtModule's signOptions.expiresIn (JWT_EXPIRES_IN_SECONDS)
      // exactly, rather than a separately hardcoded number, so this value
      // can never silently drift from the token's real lifetime.
      expiresIn: JWT_EXPIRES_IN_SECONDS,
    };
  }

  /**
   * Changes the password of the caller's own {@link Account}. The caller is
   * identified by the bearer token only (`AuthGuard`), so it works for a
   * socio, a colaborador and the shared business login alike, and right after
   * a first login with a temporary password.
   *
   * A wrong current password is a 403, NOT a 401: the frontend treats 401 as
   * an expired session and logs the person out. A stored hash that is
   * corrupt fails the same way (a 403, never a 500). The write is conditional
   * on the hash that was verified AND on the account still being active, so
   * two simultaneous changes cannot both succeed and a deactivation between
   * the read and the write is not overwritten. The account keeps exactly one
   * of the two new passwords.
   *
   * The loser of a race gets a 409 when its write finds no row to update
   * while the account is still active (both requests verified the same old
   * hash), or a 403 when it only read the account after the winner had already
   * written (its old current password no longer matches the new hash). Both
   * are correct: the caller retries with the latest password. An account
   * deactivated between the read and the write gets the same 401 as one that
   * was inactive from the start.
   *
   * Existing tokens stay valid until they expire (they are stateless); a
   * `passwordChangedAt` check would be the fix and is a known follow-up.
   * Neither the passwords nor the hashes are ever logged or returned.
   *
   * @throws UnauthorizedException when the account is missing or inactive
   * (including a deactivation that happens before the write).
   * @throws ForbiddenException when the current password does not match.
   * @throws ConflictException when another change won the race.
   */
  async changePassword(
    accountId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, active: true },
    });
    if (!account) throw new UnauthorizedException();
    if (!(await verifyPassword(account.passwordHash, currentPassword)))
      throw new ForbiddenException('Current password is incorrect');
    const passwordHash = await hashPassword(newPassword);
    const { count } = await this.prisma.account.updateMany({
      where: {
        id: account.id,
        passwordHash: account.passwordHash,
        active: true,
      },
      data: { passwordHash },
    });
    if (count === 0) {
      // No row matched: either the account was deactivated after the read
      // (same 401 as an inactive account) or another change replaced the hash
      // first (409).
      const stillActive = await this.prisma.account.findFirst({
        where: { id: account.id, active: true },
      });
      if (!stillActive) throw new UnauthorizedException();
      throw new ConflictException(
        'The password was changed by another request; try again with the latest password',
      );
    }
  }
}
