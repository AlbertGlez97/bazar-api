import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { FinanceAgreementsController } from './finance-agreements.controller.js';
import { FinanceAgreementsService } from './finance-agreements.service.js';
import { FinanceDistributionController } from './finance-distribution.controller.js';
import { FinanceDistributionService } from './finance-distribution.service.js';
import { FinanceOverviewController } from './finance-overview.controller.js';
import { FinanceOverviewService } from './finance-overview.service.js';
import { FinanceReservesController } from './finance-reserves.controller.js';
import { FinanceReservesService } from './finance-reserves.service.js';
@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [
    FinanceOverviewController,
    FinanceReservesController,
    FinanceDistributionController,
    FinanceAgreementsController,
  ],
  providers: [
    FinanceOverviewService,
    FinanceReservesService,
    FinanceDistributionService,
    FinanceAgreementsService,
  ],
})
export class FinanceModule {}
