import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { EmailModule } from '../email/email.module.js';
import { AccountInvitationsService } from './account-invitations.service.js';
import {
  MemberInvitationsController,
  PublicInvitationsController,
} from './account-invitations.controller.js';

@Module({
  imports: [AuthModule, DatabaseModule, EmailModule],
  controllers: [MemberInvitationsController, PublicInvitationsController],
  providers: [AccountInvitationsService],
})
export class InvitationsModule {}
