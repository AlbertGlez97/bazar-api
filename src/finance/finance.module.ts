import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { EmailModule } from '../email/email.module.js';
import { FinanceRulesController, PublicAgreementsController } from './finance-rules.controller.js';
import { FinanceRulesService } from './finance-rules.service.js';
import { FinanceRuleLinksService } from './finance-rule-links.service.js';
import { FinanceAgreementsController } from './finance-agreements.controller.js';
import { FinanceAgreementsService } from './finance-agreements.service.js';
import { FinanceDistributionController } from './finance-distribution.controller.js';
import { FinanceDistributionService } from './finance-distribution.service.js';
import { FinanceOverviewController } from './finance-overview.controller.js';
import { FinanceOverviewService } from './finance-overview.service.js';
import { FinancePaymentsController } from './finance-payments.controller.js';
import { FinancePaymentsService } from './finance-payments.service.js';
import { FinanceReservesController } from './finance-reserves.controller.js';
import { FinanceReservesService } from './finance-reserves.service.js';
@Module({
  imports: [AuthModule, DatabaseModule, EmailModule],
  controllers: [
    FinanceRulesController,
    PublicAgreementsController,
    FinanceOverviewController,
    FinanceReservesController,
    FinanceDistributionController,
    FinanceAgreementsController,
    FinancePaymentsController,
  ],
  providers: [
    FinanceRulesService,
    FinanceRuleLinksService,
    FinanceOverviewService,
    FinanceReservesService,
    FinanceDistributionService,
    FinanceAgreementsService,
    FinancePaymentsService,
  ],
})
export class FinanceModule {}
