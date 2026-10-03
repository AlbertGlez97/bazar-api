import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { ContributionsController } from './contributions.controller.js';
import { ContributionsService } from './contributions.service.js';
@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ContributionsController],
  providers: [ContributionsService],
})
export class ContributionsModule {}
