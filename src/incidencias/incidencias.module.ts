import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IncidenciasController } from './incidencias.controller.js';
import { IncidenciasService } from './incidencias.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [IncidenciasController],
  providers: [IncidenciasService],
})
export class IncidenciasModule {}
