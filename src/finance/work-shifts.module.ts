import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { WorkShiftsController } from './work-shifts.controller.js';
import { WorkShiftsService } from './work-shifts.service.js';
@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [WorkShiftsController],
  providers: [WorkShiftsService],
})
export class WorkShiftsModule {}
