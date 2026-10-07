import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { FinanceOverviewController } from './finance-overview.controller.js';
import { FinanceOverviewService } from './finance-overview.service.js';
import { FinanceReservesController } from './finance-reserves.controller.js';
import { FinanceReservesService } from './finance-reserves.service.js';
@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [FinanceOverviewController, FinanceReservesController],
  providers: [FinanceOverviewService, FinanceReservesService],
})
export class FinanceModule {}
