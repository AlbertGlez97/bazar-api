import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../database/database.module.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { ContextGuard } from './context.guard.js';
import { JWT_EXPIRES_IN_SECONDS } from './jwt.constants.js';
import { SocioGuard } from './socio.guard.js';

@Module({
  imports: [
    DatabaseModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const secret = process.env.JWT_SECRET;
        if (!secret || secret.length < 32)
          throw new Error('JWT_SECRET must contain at least 32 characters');
        return {
          secret,
          signOptions: {
            // Algorithm, issuer and audience are pinned on both sign and
            // verify so a token cannot be replayed against a different
            // deployment/service, and `alg: none`/downgrade attacks are
            // rejected outright rather than silently accepted.
            algorithm: 'HS256',
            // 12h (JWT_EXPIRES_IN_SECONDS) covers a full bazaar-day session
            // without needing a refresh token: devices are already
            // pre-authorized via seed (not self-registered), so a
            // longer-lived token only extends how long an *already-trusted*
            // device/session can act, not who can obtain one in the first
            // place. This directly supports the offline-sale flow: a device
            // that logs in once in the morning can keep queuing and later
            // syncing sales for the whole event without re-authenticating
            // over the network.
            expiresIn: JWT_EXPIRES_IN_SECONDS,
            issuer: 'bazar-api',
            audience: 'bazar-client',
          },
          verifyOptions: {
            algorithms: ['HS256'],
            issuer: 'bazar-api',
            audience: 'bazar-client',
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, ContextGuard, SocioGuard],
  exports: [AuthGuard, ContextGuard, SocioGuard, JwtModule],
})
export class AuthModule {}
