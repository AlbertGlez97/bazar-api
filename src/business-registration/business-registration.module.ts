import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { EmailModule } from '../email/email.module.js';
import { BusinessRegistrationController } from './business-registration.controller.js';
import { BusinessRegistrationService } from './business-registration.service.js';

@Module({
  imports: [DatabaseModule, EmailModule],
  controllers: [BusinessRegistrationController],
  providers: [BusinessRegistrationService],
})
export class BusinessRegistrationModule {}
