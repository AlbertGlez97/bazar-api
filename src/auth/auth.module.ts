import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../database/database.module.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { ContextGuard } from './context.guard.js';

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
            algorithm: 'HS256',
            expiresIn: '1h',
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
  providers: [AuthService, AuthGuard, ContextGuard],
  exports: [AuthGuard, ContextGuard, JwtModule],
})
export class AuthModule {}
