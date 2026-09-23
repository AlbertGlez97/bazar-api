import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { argon2id, hash, verify } from 'argon2';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class AuthService {
  // Argon2id hash of a random value, computed once at startup and reused on
  // every login for an unknown username. Without this, verifying against a
  // fresh dummy hash per-request would still leak via not doing any hashing
  // at all when the username doesn't exist, letting an attacker distinguish
  // "unknown user" from "wrong password" through response timing.
  private readonly dummyHash = hash(randomBytes(32).toString('hex'), {
    type: argon2id,
  });
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
    const matches = await verify(
      account?.passwordHash ?? (await this.dummyHash),
      password,
    );
    if (!account?.active || !matches)
      throw new UnauthorizedException('Invalid credentials');
    return {
      accessToken: await this.jwt.signAsync({ sub: account.id }),
      tokenType: 'Bearer',
      expiresIn: 3600,
    };
  }
}
