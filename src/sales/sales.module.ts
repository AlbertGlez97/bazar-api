import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
