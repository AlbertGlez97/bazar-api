import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DeudasController } from './deudas.controller.js';
import { DeudasService } from './deudas.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [DeudasController],
  providers: [DeudasService],
})
export class DeudasModule {}
