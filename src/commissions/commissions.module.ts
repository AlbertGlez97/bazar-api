import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { CommissionsController } from './commissions.controller.js';
import { SettingsController } from './settings.controller.js';
import { CommissionsService } from './commissions.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [CommissionsController, SettingsController],
  providers: [CommissionsService],
  // Exported so MembersController (registered directly on AppModule, with
  // no module of its own) can inject CommissionsService for
  // `PATCH /members/:id/commission-rate` without duplicating the
  // colaborador-only validation rule living in CommissionsService.
  exports: [CommissionsService],
})
export class CommissionsModule {}
