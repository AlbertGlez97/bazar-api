import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { argon2id, hash, verify } from 'argon2';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class AuthService {
  private readonly dummyHash = hash(randomBytes(32).toString('hex'), {
    type: argon2id,
  });
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

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
