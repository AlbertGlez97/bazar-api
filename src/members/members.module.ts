import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { CommissionsModule } from '../commissions/commissions.module.js';
import { EmailModule } from '../email/email.module.js';

@Module({
  imports: [AuthModule, DatabaseModule, CommissionsModule, EmailModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
