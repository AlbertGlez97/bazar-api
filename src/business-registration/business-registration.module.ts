import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { EmailModule } from '../email/email.module.js';
import { BusinessRegistrationController } from './business-registration.controller.js';
import { BusinessRegistrationService } from './business-registration.service.js';
import { RegistrationCleanupService } from './registration-cleanup.service.js';
import {
  REGISTRATION_RULES,
  RegistrationLimits,
  ipRateLimit,
} from './registration-limits.js';
import { TurnstileService } from './turnstile.service.js';

@Module({
  imports: [DatabaseModule, EmailModule],
  controllers: [BusinessRegistrationController],
  providers: [
    BusinessRegistrationService,
    TurnstileService,
    RegistrationLimits,
    RegistrationCleanupService,
  ],
})
export class BusinessRegistrationModule implements NestModule {
  constructor(private readonly limits: RegistrationLimits) {}

  /**
   * Per-IP limits as middleware (not guards: these routes are public and carry no guards).
   * They run BEFORE the body is validated, so malformed requests count too.
   */
  configure(consumer: MiddlewareConsumer): void {
    const post = (path: string) => ({ path, method: RequestMethod.POST });
    consumer
      .apply(ipRateLimit(this.limits, 'create', REGISTRATION_RULES.createPerIpPerHour))
      .forRoutes(post('business-registration'))
      .apply(ipRateLimit(this.limits, 'verify', REGISTRATION_RULES.verifyPerIpPerHour))
      .forRoutes(post('business-registration/verify-email'))
      .apply(ipRateLimit(this.limits, 'resend', REGISTRATION_RULES.resendPerIpPerHour))
      .forRoutes(post('business-registration/resend'));
  }
}
